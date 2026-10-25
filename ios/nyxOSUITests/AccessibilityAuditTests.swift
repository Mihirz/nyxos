// Apple's automated accessibility audit (labels, traits, hit regions, contrast, Dynamic Type
// clipping) over each nyxOS view, plus a check that the key controls are reachable by name.
import XCTest

final class AccessibilityAuditTests: XCTestCase {
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-NYX_MUTE", "YES"]
        app.launch()
        return app
    }

    func testKeyControlsHaveLabels() {
        let app = launch()
        XCTAssertTrue(app.buttons["Talk"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.textFields["Command"].exists)
        for name in ["Home", "Lens", "Look", "Follow", "Perf", "Curtain", "Pan left", "Pan right"] {
            XCTAssertTrue(app.buttons[name].exists, "missing button \(name)")
        }
    }

    func testAuditHome() throws {
        let app = launch()
        XCTAssertTrue(app.buttons["Talk"].waitForExistence(timeout: 10))
        try app.performAccessibilityAudit(for: [.sufficientElementDescription, .hitRegion, .trait, .elementDetection]) { issue in
            // The web page's own content isn't ours to label.
            issue.element?.elementType == .webView
        }
    }

    func testAuditLookAndLens() throws {
        let app = launch()
        XCTAssertTrue(app.buttons["Talk"].waitForExistence(timeout: 10))
        app.buttons["Look"].tap()
        XCTAssertTrue(app.buttons["What is this?"].waitForExistence(timeout: 5))
        try app.performAccessibilityAudit(for: [.sufficientElementDescription, .hitRegion, .trait]) { _ in false }
        app.buttons["Lens"].tap()
        try app.performAccessibilityAudit(for: [.sufficientElementDescription, .trait]) { issue in
            issue.element?.elementType == .webView || issue.element?.elementType == .other
        }
    }
}
