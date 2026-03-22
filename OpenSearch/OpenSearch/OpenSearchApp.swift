import SwiftUI

@main
struct OpenSearchApp: App {
    @State private var serverManager = ServerManager()

    var body: some Scene {
        WindowGroup {
            Group {
                switch serverManager.state {
                case .running:
                    ContentView()
                case .starting, .stopped:
                    ServerStartingView()
                case .failed(let message):
                    ServerErrorView(message: message) {
                        serverManager.start()
                    }
                }
            }
            .onAppear {
                serverManager.start()
            }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                serverManager.stop()
            }
        }
        .defaultSize(width: 800, height: 600)
    }
}

struct ServerStartingView: View {
    var body: some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
            Text("Starting server...")
                .font(.title3)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct ServerErrorView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 40))
                .foregroundStyle(.orange)
            Text("Server Error")
                .font(.title2)
                .fontWeight(.semibold)
            Text(message)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            Button("Retry") {
                retry()
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
