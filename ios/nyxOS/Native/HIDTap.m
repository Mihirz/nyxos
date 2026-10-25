#import "HIDTap.h"
#import <dlfcn.h>
#import <mach/mach_time.h>
#import <objc/message.h>
#import <objc/runtime.h>

typedef struct __IOHIDEvent *IOHIDEventRef;
typedef double IOHIDFloat;

typedef IOHIDEventRef (*CreateDigitizerEventFn)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t,
                                                IOHIDFloat, IOHIDFloat, IOHIDFloat, IOHIDFloat, IOHIDFloat, Boolean, Boolean, uint32_t);
typedef IOHIDEventRef (*CreateFingerEventFn)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t,
                                             IOHIDFloat, IOHIDFloat, IOHIDFloat, IOHIDFloat, IOHIDFloat, Boolean, Boolean, uint32_t);
typedef void (*AppendEventFn)(IOHIDEventRef, IOHIDEventRef, uint32_t);
typedef void (*SetIntegerValueFn)(IOHIDEventRef, uint32_t, long);
typedef void (*SetFloatValueFn)(IOHIDEventRef, uint32_t, IOHIDFloat);
typedef void (*SetSenderIDFn)(IOHIDEventRef, uint64_t);
typedef void (*SetDigitizerInfoFn)(IOHIDEventRef, uint32_t, Boolean, Boolean, CFStringRef, CFTimeInterval, float);

// IOHIDEventTypes.h
enum { kTransducerHand = 3 };
enum { kMaskRange = 1 << 0, kMaskTouch = 1 << 1, kMaskPosition = 1 << 2, kMaskIdentity = 1 << 5, kMaskAttribute = 1 << 6 };
#define FIELD_DIGITIZER(n) ((11 << 16) | (n))
enum { kFieldMajorRadius = FIELD_DIGITIZER(20), kFieldMinorRadius = FIELD_DIGITIZER(21), kFieldIsDisplayIntegrated = FIELD_DIGITIZER(25) };

static CreateDigitizerEventFn createDigitizer;
static CreateFingerEventFn createFinger;
static AppendEventFn appendEvent;
static SetIntegerValueFn setInteger;
static SetFloatValueFn setFloat;
static SetSenderIDFn setSender;
static SetDigitizerInfoFn setDigitizerInfo;
static BOOL loaded, ok;

static void load(void) {
    if (loaded) return;
    loaded = YES;
    void *iokit = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW);
    void *bks = dlopen("/System/Library/PrivateFrameworks/BackBoardServices.framework/BackBoardServices", RTLD_NOW);
    if (!iokit) return;
    createDigitizer = (CreateDigitizerEventFn)dlsym(iokit, "IOHIDEventCreateDigitizerEvent");
    createFinger = (CreateFingerEventFn)dlsym(iokit, "IOHIDEventCreateDigitizerFingerEvent");
    appendEvent = (AppendEventFn)dlsym(iokit, "IOHIDEventAppendEvent");
    setInteger = (SetIntegerValueFn)dlsym(iokit, "IOHIDEventSetIntegerValue");
    setFloat = (SetFloatValueFn)dlsym(iokit, "IOHIDEventSetFloatValue");
    setSender = (SetSenderIDFn)dlsym(iokit, "IOHIDEventSetSenderID");
    if (bks) setDigitizerInfo = (SetDigitizerInfoFn)dlsym(bks, "BKSHIDEventSetDigitizerInfo");
    ok = createDigitizer && createFinger && appendEvent && setInteger && setFloat
        && [[UIApplication sharedApplication] respondsToSelector:NSSelectorFromString(@"_enqueueHIDEvent:")];
}

static IOHIDEventRef makeEvent(CGPoint p, BOOL touching) {
    uint32_t mask = kMaskTouch | kMaskIdentity;
    uint64_t now = mach_absolute_time();
    IOHIDEventRef hand = createDigitizer(kCFAllocatorDefault, now, kTransducerHand, 0, 0, mask, 0, 0, 0, 0, 0, 0, 0, touching, 0);
    setInteger(hand, kFieldIsDisplayIntegrated, 1);
    IOHIDEventRef finger = createFinger(kCFAllocatorDefault, now, 1, 2, mask, round(p.x), round(p.y), 0, 0, 0, touching, touching, 0);
    setFloat(finger, kFieldMajorRadius, touching ? 5 : 0);
    setFloat(finger, kFieldMinorRadius, touching ? 5 : 0);
    appendEvent(hand, finger, 0);
    CFRelease(finger);
    if (setSender) setSender(hand, 0x0000000123456789ULL);
    return hand;
}

static void send(IOHIDEventRef e, UIWindow *window) {
    if (setDigitizerInfo) {
        uint32_t contextID = 0;
        SEL sel = NSSelectorFromString(@"_contextId");
        if ([window respondsToSelector:sel]) contextID = ((uint32_t (*)(id, SEL))objc_msgSend)(window, sel);
        if (contextID) setDigitizerInfo(e, contextID, false, false, NULL, 0, 0);
    }
    ((void (*)(id, SEL, IOHIDEventRef))objc_msgSend)([UIApplication sharedApplication], NSSelectorFromString(@"_enqueueHIDEvent:"), e);
}

@implementation NYXHIDTap

+ (BOOL)available { load(); return ok; }

+ (BOOL)tapAtWindowPoint:(CGPoint)point window:(UIWindow *)window {
    load();
    if (!ok) return NO;
    // Window points to screen points (the same for a full-screen app).
    CGPoint p = [window convertPoint:point toCoordinateSpace:window.screen.coordinateSpace];
    IOHIDEventRef down = makeEvent(p, YES);
    send(down, window);
    CFRelease(down);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(80 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
        IOHIDEventRef up = makeEvent(p, NO);
        send(up, window);
        CFRelease(up);
    });
    return YES;
}

@end

@implementation NYXKeyboard

static UIView *emptyInputView(id self, SEL _cmd) {
    static UIView *v;
    if (!v) v = [[UIView alloc] initWithFrame:CGRectZero];
    return v;
}

static UIView *noAccessory(id self, SEL _cmd) { return nil; }

+ (void)suppressForWebViews {
    static BOOL done;
    if (done) return;
    done = YES;
    Class c = NSClassFromString(@"WKContentView");
    if (!c) return;
    // Only WKContentView's own methods change, never UIResponder's (the command bar keeps its keyboard).
    if (!class_addMethod(c, @selector(inputView), (IMP)emptyInputView, "@@:"))
        method_setImplementation(class_getInstanceMethod(c, @selector(inputView)), (IMP)emptyInputView);
    if (!class_addMethod(c, @selector(inputAccessoryView), (IMP)noAccessory, "@@:"))
        method_setImplementation(class_getInstanceMethod(c, @selector(inputAccessoryView)), (IMP)noAccessory);
}

@end
