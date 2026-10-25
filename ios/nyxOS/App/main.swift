import UIKit

// A UIApplication subclass so hardware keys reach nyxOS whatever has focus (see KeyRouter).
UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, NSStringFromClass(NyxApplication.self), NSStringFromClass(AppDelegate.self))
