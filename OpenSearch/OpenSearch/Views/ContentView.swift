import SwiftUI

enum AppTab: String, CaseIterable, Identifiable {
    case actions = "Actions Needed"
    case conversations = "Recent Conversations"
    case search = "Search Messages"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .actions: "checklist"
        case .conversations: "bubble.left.and.text.bubble.right"
        case .search: "magnifyingglass"
        }
    }
}

struct ContentView: View {
    @State private var viewModel = SearchViewModel()
    @State private var selectedTab: AppTab = .search
    @State private var showSettings: Bool = false
    @AppStorage("hasCompletedOnboarding") private var hasCompletedOnboarding: Bool = false

    var body: some View {
        VStack(spacing: 0) {
            if !hasCompletedOnboarding {
                OnboardingView(viewModel: viewModel) {
                    hasCompletedOnboarding = true
                    if viewModel.hasApiKey {
                        selectedTab = .actions
                    }
                }
            } else if viewModel.threadAnchorId != nil {
                ThreadView(viewModel: viewModel)
            } else {
                // Top bar: tabs on the left, sync + settings on the right
                HStack(spacing: 0) {
                    ForEach(AppTab.allCases) { tab in
                        tabButton(tab)
                    }

                    Spacer()

                    syncButton
                    settingsButton
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)

                Divider()

                // Content for selected tab
                switch selectedTab {
                case .conversations:
                    if viewModel.hasApiKey {
                        ChatMetadataPanelView(viewModel: viewModel)
                    } else {
                        apiKeyRequiredView
                    }
                case .actions:
                    if viewModel.hasApiKey {
                        ActionsPanelView(viewModel: viewModel)
                    } else {
                        apiKeyRequiredView
                    }
                case .search:
                    SearchBarView(viewModel: viewModel)
                        .padding(.horizontal)
                        .padding(.top, 8)
                        .zIndex(1)
                    ResultsListView(viewModel: viewModel)
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(viewModel: viewModel)
        }
        .onChange(of: viewModel.hasApiKey) {
            // If key was just added and we're on a disabled tab placeholder, stay there
            // If key was removed and we're on an LLM tab, switch to search
            if !viewModel.hasApiKey && selectedTab != .search {
                selectedTab = .search
            }
        }
        .frame(minWidth: 600, minHeight: 400)
    }

    private var apiKeyRequiredView: some View {
        VStack(spacing: 16) {
            Image(systemName: "key")
                .font(.system(size: 48))
                .foregroundStyle(.tertiary)
            Text("API Key Required")
                .font(.title3)
                .foregroundStyle(.secondary)
            Text("Add an Anthropic or OpenAI API key in Settings to enable conversation summaries and action items.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 60)
            Button("Open Settings") {
                showSettings = true
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func tabButton(_ tab: AppTab) -> some View {
        let requiresKey = (tab == .actions || tab == .conversations)
        let disabled = requiresKey && !viewModel.hasApiKey

        return Button {
            withAnimation(.easeInOut(duration: 0.15)) {
                selectedTab = tab
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: tab.icon)
                    .font(.caption)
                Text(tab.rawValue)
                    .font(.caption)
                    .fontWeight(.medium)

                if tab == .conversations && !viewModel.chatMetadata.isEmpty {
                    badgeView(count: viewModel.chatMetadata.count, color: .blue)
                }
                if tab == .actions && !viewModel.actions.isEmpty {
                    badgeView(count: viewModel.actions.count, color: .orange)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(selectedTab == tab ? Color.accentColor.opacity(0.15) : Color.clear)
            .foregroundColor(disabled ? .gray : (selectedTab == tab ? .accentColor : .secondary))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    private func badgeView(count: Int, color: Color) -> some View {
        Text("\(count)")
            .font(.caption2)
            .fontWeight(.semibold)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(color.opacity(0.2))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }

    private var syncButton: some View {
        Button {
            Task { await viewModel.sync() }
        } label: {
            if viewModel.isSyncing {
                ProgressView()
                    .controlSize(.small)
            } else {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.title3)
            }
        }
        .buttonStyle(.plain)
        .disabled(viewModel.isSyncing)
        .help(viewModel.syncTooltip)
        .padding(.trailing, 8)
    }

    private var settingsButton: some View {
        Button {
            showSettings = true
        } label: {
            Image(systemName: "gearshape")
                .font(.title3)
        }
        .buttonStyle(.plain)
        .help("Settings")
    }
}

// MARK: - Onboarding

struct OnboardingView: View {
    @Bindable var viewModel: SearchViewModel
    let onComplete: () -> Void

    @State private var anthropicKeyInput: String = ""
    @State private var openaiKeyInput: String = ""
    @State private var isSaving: Bool = false
    @State private var errorMessage: String? = nil

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "magnifyingglass.circle.fill")
                .font(.system(size: 64))
                .foregroundStyle(Color.accentColor)

            Text("Welcome to OpenSearch")
                .font(.title)
                .fontWeight(.semibold)

            Text("Search your iMessage history with full-text and semantic search.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)

            VStack(alignment: .leading, spacing: 16) {
                Text("Add an API key (optional)")
                    .font(.headline)

                Text("An Anthropic or OpenAI key enables conversation summaries and action item tracking. You can skip this and add one later in Settings.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 4) {
                    Text("Anthropic API Key")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    SecureField("sk-ant-...", text: $anthropicKeyInput)
                        .textFieldStyle(.roundedBorder)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text("OpenAI API Key")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    SecureField("sk-...", text: $openaiKeyInput)
                        .textFieldStyle(.roundedBorder)
                }

                if let error = errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            .frame(width: 340)

            HStack(spacing: 16) {
                Button("Skip") {
                    onComplete()
                }
                .buttonStyle(.bordered)

                Button("Get Started") {
                    Task { await saveAndContinue() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isSaving)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func saveAndContinue() async {
        isSaving = true
        errorMessage = nil

        var updates: [String: String] = [:]
        if !anthropicKeyInput.isEmpty {
            updates["anthropicApiKey"] = anthropicKeyInput
        }
        if !openaiKeyInput.isEmpty {
            updates["openaiApiKey"] = openaiKeyInput
        }

        if !updates.isEmpty {
            do {
                try await viewModel.updateSettings(updates)
                viewModel.hasApiKey = true
            } catch {
                errorMessage = "Failed to save API key. Make sure the server is running."
                isSaving = false
                return
            }
        }

        isSaving = false
        onComplete()
    }
}

#Preview {
    ContentView()
}
