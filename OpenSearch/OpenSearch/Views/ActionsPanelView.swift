import SwiftUI

struct ActionsPanelView: View {
    @Bindable var viewModel: SearchViewModel

    var body: some View {
        Group {
            if viewModel.isLoadingActions {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Loading actions...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if viewModel.actions.isEmpty && viewModel.completedActions.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "checklist")
                        .font(.system(size: 48))
                        .foregroundStyle(.tertiary)
                    Text("No actions needed")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    Text("Action items will appear here after syncing")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(viewModel.actions) { action in
                            ActionRowView(action: action, viewModel: viewModel)
                        }

                        if viewModel.actions.isEmpty && !viewModel.completedActions.isEmpty {
                            Text("All caught up!")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .padding(.vertical, 8)
                        }

                        // Show completed toggle
                        if !viewModel.completedActions.isEmpty || viewModel.showCompletedActions {
                            Button {
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    viewModel.showCompletedActions.toggle()
                                }
                                if viewModel.showCompletedActions && viewModel.completedActions.isEmpty {
                                    Task { await viewModel.loadCompletedActions() }
                                }
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 8))
                                        .rotationEffect(.degrees(viewModel.showCompletedActions ? 90 : 0))
                                    Text("Completed (\(viewModel.completedActions.count))")
                                        .font(.caption2)
                                    Spacer()
                                }
                                .foregroundStyle(.secondary)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .padding(.top, 4)
                        }

                        if viewModel.showCompletedActions {
                            ForEach(viewModel.completedActions) { action in
                                CompletedActionRowView(action: action)
                            }
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
            }
        }
        .onAppear {
            Task {
                await viewModel.loadActions()
                await viewModel.loadCompletedActions()
            }
        }
    }
}

struct ActionRowView: View {
    let action: ActionItem
    let viewModel: SearchViewModel
    @State private var markedDone = false

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(action.action_descriptor)
                    .font(.caption)
                    .lineLimit(2)
                    .strikethrough(markedDone)
                    .opacity(markedDone ? 0.5 : 1)

                HStack(spacing: 8) {
                    if let chatName = action.chat_name {
                        Label(chatName, systemImage: "bubble.left")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if let dueDate = action.due_date {
                        Label(dueDateText(dueDate), systemImage: "calendar")
                            .font(.caption2)
                            .foregroundStyle(isPastDue(dueDate) ? .red : .secondary)
                    }
                }
                .opacity(markedDone ? 0.5 : 1)
            }

            Spacer(minLength: 0)

            // Mark done button
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    markedDone = true
                }
                Task {
                    try? await Task.sleep(nanoseconds: 400_000_000)
                    await viewModel.completeAction(id: action.id)
                }
            } label: {
                Image(systemName: markedDone ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20))
                    .foregroundStyle(markedDone ? .green : .orange)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Mark as done")
            .disabled(markedDone)
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
        .background(Color.primary.opacity(0.03))
        .cornerRadius(6)
        .contentShape(Rectangle())
        .onTapGesture {
            if let messageId = action.message_id {
                Task { await viewModel.openThread(for: messageId) }
            }
        }
    }

    private func dueDateText(_ date: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(date) {
            return "Today"
        } else if cal.isDateInTomorrow(date) {
            return "Tomorrow"
        } else {
            return date.dayFormatted
        }
    }

    private func isPastDue(_ date: Date) -> Bool {
        date < Date() && !Calendar.current.isDateInToday(date)
    }
}

struct CompletedActionRowView: View {
    let action: ActionItem

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 14))
                .foregroundStyle(.green.opacity(0.5))
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 2) {
                Text(action.action_descriptor)
                    .font(.caption)
                    .lineLimit(2)
                    .strikethrough()
                    .foregroundStyle(.secondary)

                if let chatName = action.chat_name {
                    Label(chatName, systemImage: "bubble.left")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 6)
    }
}
