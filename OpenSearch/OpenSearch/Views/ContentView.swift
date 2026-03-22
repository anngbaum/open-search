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
    @State private var selectedTab: AppTab = .actions
    @State private var showSettings: Bool = false

    var body: some View {
        VStack(spacing: 0) {
            if viewModel.threadAnchorId != nil {
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
                    ChatMetadataPanelView(viewModel: viewModel)
                case .actions:
                    ActionsPanelView(viewModel: viewModel)
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
        .frame(minWidth: 600, minHeight: 400)
    }

    private func tabButton(_ tab: AppTab) -> some View {
        Button {
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
            .foregroundStyle(selectedTab == tab ? Color.accentColor : .secondary)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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

#Preview {
    ContentView()
}
