// Real taps for the Lens. Some web games (NYT Connections) ignore script-made clicks
// (event.isTrusted is false), and WKWebView has no public way to send input. This builds the
// same touch events the touchscreen produces and hands them to UIKit, the way WebKit's own test
// runner does (HIDEventGenerator): UIKit hit-tests them, WebKit's tap recognizer fires, and the
// page gets a trusted click. Everything is looked up at run time; if a symbol is missing,
// `available` is NO and the Lens falls back to script events.

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface NYXHIDTap : NSObject
/// The private entry points were found.
@property (class, readonly) BOOL available;
/// Tap at a point in window coordinates (points). Returns NO if taps aren't available.
+ (BOOL)tapAtWindowPoint:(CGPoint)point window:(UIWindow *)window;
@end

/// The on-screen keyboard never opens for the Lens page (like the desktop, where keyboard focus
/// never stays in the page): nyxOS types into pages itself, and the keyboard would cover the
/// Talk button. Typing for the user goes through the command bar ("t hello").
@interface NYXKeyboard : NSObject
+ (void)suppressForWebViews;
@end

NS_ASSUME_NONNULL_END
