import Foundation
import Testing
@testable import SofarCore

/// The Swift face of crates/sofar-ffi (rust-core 5.2): the bodies decode as
/// `sofar serve`'s do, and refusals arrive as typed errors. SOFAR_REPO_ROOT
/// names a repo with a record; build-apple.sh sets it to the sofar checkout.
struct SofarCoreTests {
    let root = ProcessInfo.processInfo.environment["SOFAR_REPO_ROOT"] ?? ""

    private struct AllStates: Decodable {
        struct State: Decodable { let slug: String; let goal: String }
        let initiatives: [String: State]
    }

    @Test func stateJsonDecodesAsServeDoes() throws {
        try #require(!root.isEmpty, "set SOFAR_REPO_ROOT")
        let body = try stateJson(repoRoot: root)
        let all = try JSONDecoder().decode(AllStates.self, from: Data(body.utf8))
        let slugs = try initiativeSlugs(repoRoot: root)
        #expect(all.initiatives.keys.sorted() == slugs.sorted())
        #expect(slugs.contains("rust-core"))
        for (slug, state) in all.initiatives { #expect(state.slug == slug) }
    }

    @Test func oneInitiativeIsItsSliceOfTheWhole() throws {
        try #require(!root.isEmpty, "set SOFAR_REPO_ROOT")
        let one = try initiativeJson(repoRoot: root, slug: "rust-core")
        #expect(try stateJson(repoRoot: root).contains("\"rust-core\":\(one)"))
    }

    @Test func anUnknownSlugIsATypedError() {
        #expect(throws: RecordError.UnknownInitiative(slug: "../..")) {
            try initiativeJson(repoRoot: root, slug: "../..")
        }
    }

    @Test func versionNamesEngineAndSchema() {
        let v = coreVersion()
        #expect(v.contains("\"engine\":") && v.contains("\"schema\":"))
    }
}
