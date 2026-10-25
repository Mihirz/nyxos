// Messages on iOS. Apps can't read iMessage history, so there's no unread triage. Sending goes
// through MFMessageComposeViewController: nyxOS reads the message back, the user says yes, and the
// Messages sheet opens filled in; nothing leaves the phone until the user taps Send.

import Contacts
import MessageUI
import UIKit

struct ContactMatch {
    var name: String
    var handles: [String]
}

@MainActor
final class Messaging: NSObject {
    static let shared = Messaging()
    private let store = CNContactStore()
    private var onResult: ((MessageComposeResult) -> Void)?

    /// People in Contacts whose name contains the spoken name, with phones (mobile first) and emails.
    func findContacts(_ spoken: String) async -> [ContactMatch] {
        let ok: Bool
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized, .limited: ok = true
        case .notDetermined: ok = (try? await store.requestAccess(for: .contacts)) ?? false
        default: ok = false
        }
        guard ok else { return [] }
        let keys: [CNKeyDescriptor] = [CNContactFormatter.descriptorForRequiredKeys(for: .fullName), CNContactPhoneNumbersKey as CNKeyDescriptor, CNContactEmailAddressesKey as CNKeyDescriptor]
        let people = (try? store.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: spoken), keysToFetch: keys)) ?? []
        return people.map { c in
            let phones = c.phoneNumbers.sorted { a, b in
                let mobile = { (l: String?) in l == CNLabelPhoneNumberMobile || l == CNLabelPhoneNumberiPhone }
                return mobile(a.label) && !mobile(b.label)
            }.map { $0.value.stringValue }
            let emails = c.emailAddresses.map { $0.value as String }
            return ContactMatch(name: CNContactFormatter.string(from: c, style: .fullName) ?? spoken, handles: phones + emails)
        }
    }

    var canSend: Bool { MFMessageComposeViewController.canSendText() }

    /// Opens the Messages sheet with the recipient and text filled in. The user taps Send.
    func compose(to handle: String, body: String, onResult: @escaping (MessageComposeResult) -> Void) -> Bool {
        guard canSend, let top = UIApplication.topViewController() else { return false }
        let vc = MFMessageComposeViewController()
        vc.recipients = [handle]
        vc.body = body
        vc.messageComposeDelegate = self
        self.onResult = onResult
        top.present(vc, animated: true) {
            // VoiceOver lands on the sheet; point it at the message so Send is one swipe away.
            UIAccessibility.post(notification: .screenChanged, argument: nil)
        }
        return true
    }
}

extension Messaging: MFMessageComposeViewControllerDelegate {
    nonisolated func messageComposeViewController(_ controller: MFMessageComposeViewController, didFinishWith result: MessageComposeResult) {
        MainActor.assumeIsolated {
            controller.dismiss(animated: true)
            onResult?(result)
            onResult = nil
        }
    }
}

let isHandle = { (s: String) -> Bool in
    s.contains("@") || s.trimmingCharacters(in: .whitespaces).range(of: "^[+\\d][\\d\\s().-]{6,}$", options: .regularExpression) != nil
}

extension UIApplication {
    static func topViewController() -> UIViewController? {
        let scene = shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var vc = scene?.windows.first { $0.isKeyWindow }?.rootViewController ?? scene?.windows.first?.rootViewController
        while let p = vc?.presentedViewController { vc = p }
        return vc
    }
}
