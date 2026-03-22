import Foundation

struct TypeaheadSuggestion: Identifiable {
    enum Kind { case withContact, sentBy, group }
    let id: String
    let title: String
    let subtitle: String?
    let icon: String
    let kind: Kind
    let contact: Contact?
    let group: GroupChat?
}

@Observable
final class SearchViewModel {
    var query: String = ""
    var mode: SearchMode = .hybrid
    var filters = SearchFilters()

    private(set) var results: [SearchResult] = []
    private(set) var isSearching: Bool = false
    private(set) var isLoadingMore: Bool = false
    private(set) var hasMore: Bool = false
    private(set) var errorMessage: String? = nil
    private(set) var hasSearched: Bool = false

    // Contacts & groups for typeahead
    private(set) var contacts: [Contact] = []
    private(set) var groups: [GroupChat] = []

    // Typeahead state
    private(set) var showTypeahead: Bool = false
    private(set) var typeaheadSuggestions: [TypeaheadSuggestion] = []
    private(set) var activeKeyword: String? = nil

    // Sync state
    private(set) var isSyncing: Bool = false
    private(set) var lastSyncMessage: String? = nil
    private(set) var lastSyncedAt: Date? = nil

    var syncTooltip: String {
        if isSyncing { return "Syncing..." }
        if let date = lastSyncedAt {
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .abbreviated
            let relative = formatter.localizedString(for: date, relativeTo: Date())
            if let msg = lastSyncMessage {
                return "\(msg)\nLast synced: \(relative)"
            }
            return "Last synced: \(relative)"
        }
        return lastSyncMessage ?? "Sync new messages"
    }

    // Chat metadata panel
    private(set) var chatMetadata: [ChatMetadata] = []
    private(set) var isLoadingMetadata: Bool = false
    var showMetadataPanel: Bool = false

    // Actions panel
    private(set) var actions: [ActionItem] = []
    private(set) var completedActions: [ActionItem] = []
    private(set) var isLoadingActions: Bool = false
    var showActionsPanel: Bool = false
    var showCompletedActions: Bool = false

    // Context messages keyed by result message ID
    private(set) var contextMessages: [Int: [ContextMessage]] = [:]
    private(set) var loadingContext: Set<Int> = []
    var expandedResults: Set<Int> = []

    // Thread view state
    private(set) var threadResponse: ThreadResponse? = nil
    private(set) var isLoadingThread: Bool = false
    private(set) var isLoadingMoreThread: Bool = false
    private(set) var threadError: String? = nil
    var threadAnchorId: Int? = nil

    // API key state — controls whether LLM-powered tabs are available
    var hasApiKey: Bool = false

    private let service = SearchService()

    init() {
        // Apply default preset dates
        filters.applyPreset(.pastMonth)
        Task {
            await loadContacts()
            await loadGroups()
            await checkApiKeyStatus()
        }
    }

    @MainActor
    func checkApiKeyStatus() async {
        do {
            let settings = try await service.fetchSettings()
            hasApiKey = (settings.anthropicApiKey != nil || settings.openaiApiKey != nil)
        } catch {
            hasApiKey = false
        }
    }

    // MARK: - Typeahead

    private let keywords = ["with:", "sent_by:", "in:"]

    func updateTypeahead() {
        // Check keywords in order of specificity (longest first)
        if let sentByQuery = extractKeyword("sent_by:") {
            activeKeyword = "sent_by:"
            buildContactSuggestions(query: sentByQuery, kind: .sentBy, includeMeOption: true)
        } else if let withQuery = extractKeyword("with:") {
            activeKeyword = "with:"
            buildContactSuggestions(query: withQuery, kind: .withContact, includeMeOption: false)
        } else if let inQuery = extractKeyword("in:") {
            activeKeyword = "in:"
            buildGroupSuggestions(query: inQuery)
        } else {
            dismissTypeahead()
        }
    }

    private func buildContactSuggestions(query searchText: String, kind: TypeaheadSuggestion.Kind, includeMeOption: Bool) {
        var suggestions: [TypeaheadSuggestion] = []

        if includeMeOption && !filters.sentByMe && (searchText.isEmpty || "me".localizedCaseInsensitiveContains(searchText)) {
            suggestions.append(TypeaheadSuggestion(
                id: "sent-by-me",
                title: "me",
                subtitle: "Messages I sent",
                icon: "person.fill",
                kind: .sentBy,
                contact: nil,
                group: nil
            ))
        }

        let alreadySelected: Set<String>
        switch kind {
        case .withContact:
            alreadySelected = Set(filters.withContacts.map(\.id))
        case .sentBy:
            alreadySelected = Set(filters.sentByContacts.map(\.id))
        default:
            alreadySelected = []
        }

        suggestions += contacts
            .filter {
                !alreadySelected.contains($0.id) &&
                (searchText.isEmpty ||
                 $0.name.localizedCaseInsensitiveContains(searchText) ||
                 $0.identifiers.contains(where: { $0.localizedCaseInsensitiveContains(searchText) }))
            }
            .prefix(6)
            .map { contact in
                let subtitle = contact.identifiers.first(where: { $0 != contact.name }) ?? contact.identifiers.first
                return TypeaheadSuggestion(
                    id: "\(kind)-\(contact.id)",
                    title: contact.name,
                    subtitle: subtitle,
                    icon: "person",
                    kind: kind,
                    contact: contact,
                    group: nil
                )
            }

        typeaheadSuggestions = Array(suggestions.prefix(6))
        showTypeahead = !typeaheadSuggestions.isEmpty
    }

    private func buildGroupSuggestions(query searchText: String) {
        typeaheadSuggestions = groups
            .filter {
                searchText.isEmpty || $0.name.localizedCaseInsensitiveContains(searchText)
            }
            .prefix(6)
            .map { group in
                TypeaheadSuggestion(
                    id: "group-\(group.id)",
                    title: group.name,
                    subtitle: nil,
                    icon: "bubble.left.and.bubble.right",
                    kind: .group,
                    contact: nil,
                    group: group
                )
            }
        showTypeahead = !typeaheadSuggestions.isEmpty
    }

    private func extractKeyword(_ keyword: String) -> String? {
        let lower = query.lowercased()
        guard let range = lower.range(of: keyword, options: .backwards) else { return nil }
        if range.lowerBound != lower.startIndex {
            let charBefore = lower[lower.index(before: range.lowerBound)]
            if !charBefore.isWhitespace { return nil }
        }
        let afterKeyword = String(query[range.upperBound...])
        let afterLower = afterKeyword.lowercased()
        // Make sure no other keyword appears after this one
        for kw in keywords where kw != keyword {
            if afterLower.contains(kw) { return nil }
        }
        return afterKeyword
    }

    func selectTypeaheadSuggestion(_ suggestion: TypeaheadSuggestion) {
        // Remove the keyword portion from the query
        if let keyword = activeKeyword,
           let range = query.lowercased().range(of: keyword, options: .backwards) {
            query = String(query[query.startIndex..<range.lowerBound]).trimmingCharacters(in: .whitespaces)
        }

        switch suggestion.kind {
        case .withContact:
            if let contact = suggestion.contact {
                addWithContact(contact)
            }
        case .sentBy:
            if let contact = suggestion.contact {
                addSentByContact(contact)
            } else if suggestion.id == "sent-by-me" {
                filters.sentByMe = true
            }
        case .group:
            if let group = suggestion.group {
                filters.groupChat = group
            }
        }

        dismissTypeahead()
    }

    func dismissTypeahead() {
        showTypeahead = false
        typeaheadSuggestions = []
        activeKeyword = nil
    }

    // MARK: - Contact management

    func addWithContact(_ contact: Contact) {
        if !filters.withContacts.contains(contact) {
            filters.withContacts.append(contact)
        }
    }

    func removeWithContact(_ contact: Contact) {
        filters.withContacts.removeAll { $0.id == contact.id }
    }

    func addSentByContact(_ contact: Contact) {
        if !filters.sentByContacts.contains(contact) {
            filters.sentByContacts.append(contact)
        }
    }

    func removeSentByContact(_ contact: Contact) {
        filters.sentByContacts.removeAll { $0.id == contact.id }
    }

    // MARK: - Search

    private let pageSize = 20

    @MainActor
    func search() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        isSearching = true
        errorMessage = nil
        hasSearched = true
        hasMore = false
        expandedResults.removeAll()
        contextMessages.removeAll()

        do {
            let response = try await service.search(
                query: trimmed,
                mode: mode,
                filters: filters,
                limit: pageSize,
                offset: 0
            )
            results = response.results
            hasMore = response.hasMore
        } catch is URLError {
            results = []
            errorMessage = "Cannot connect to server. Make sure `npm run serve` is running."
        } catch {
            results = []
            errorMessage = error.localizedDescription
        }

        isSearching = false
    }

    @MainActor
    func loadMore() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, hasMore, !isLoadingMore else { return }

        isLoadingMore = true

        do {
            let response = try await service.search(
                query: trimmed,
                mode: mode,
                filters: filters,
                limit: pageSize,
                offset: results.count
            )
            results += response.results
            hasMore = response.hasMore
        } catch {
            // Silently fail — user can retry
        }

        isLoadingMore = false
    }

    func clearAll() {
        query = ""
        filters.reset()
        dismissTypeahead()
    }

    // MARK: - Data loading

    @MainActor
    func loadContacts() async {
        do {
            contacts = try await service.fetchContacts()
        } catch {
            contacts = []
        }
    }

    @MainActor
    func loadGroups() async {
        do {
            groups = try await service.fetchGroups()
        } catch {
            groups = []
        }
    }

    // MARK: - Sync

    @MainActor
    func sync() async {
        isSyncing = true
        lastSyncMessage = nil

        do {
            let result = try await service.sync()
            lastSyncMessage = "Synced \(result.messagesAdded) new messages"
            lastSyncedAt = Date()
            await loadContacts()
            await loadGroups()
            await loadChatMetadata()
            await loadActions()
        } catch is URLError {
            lastSyncMessage = "Sync failed: cannot connect to server"
        } catch {
            lastSyncMessage = "Sync failed: \(error.localizedDescription)"
        }

        isSyncing = false
    }

    // MARK: - Thread

    @MainActor
    func openThread(for messageId: Int) async {
        threadAnchorId = messageId
        isLoadingThread = true
        threadError = nil
        threadResponse = nil

        do {
            threadResponse = try await service.fetchThread(messageId: messageId)
        } catch is URLError {
            threadError = "Cannot connect to server. Make sure `npm run serve` is running."
        } catch {
            threadError = error.localizedDescription
        }

        isLoadingThread = false
    }

    @MainActor
    func loadMoreThread(direction: String) async {
        guard let response = threadResponse,
              let anchorId = threadAnchorId else { return }

        let cursor = direction == "older" ? response.cursors.older : response.cursors.newer
        guard let cursor else { return }

        isLoadingMoreThread = true

        do {
            let page = try await service.fetchThread(
                messageId: anchorId,
                cursor: cursor,
                direction: direction
            )

            if direction == "older" {
                threadResponse = ThreadResponse(
                    chat: response.chat,
                    anchor_message_id: response.anchor_message_id,
                    messages: page.messages + response.messages,
                    cursors: ThreadCursors(older: page.cursors.older, newer: response.cursors.newer),
                    has_older: page.has_older,
                    has_newer: response.has_newer
                )
            } else {
                threadResponse = ThreadResponse(
                    chat: response.chat,
                    anchor_message_id: response.anchor_message_id,
                    messages: response.messages + page.messages,
                    cursors: ThreadCursors(older: response.cursors.older, newer: page.cursors.newer),
                    has_older: response.has_older,
                    has_newer: page.has_newer
                )
            }
        } catch {
            // Silently fail pagination — the user can retry
        }

        isLoadingMoreThread = false
    }

    func closeThread() {
        threadAnchorId = nil
        threadResponse = nil
        threadError = nil
    }

    // MARK: - Chat Metadata

    @MainActor
    func loadChatMetadata() async {
        isLoadingMetadata = true
        do {
            chatMetadata = try await service.fetchChatMetadata()
        } catch {
            chatMetadata = []
        }
        isLoadingMetadata = false
    }

    private(set) var refreshingMetadataChats: Set<Int> = []

    @MainActor
    func refreshChatMetadata(chatId: Int) async {
        refreshingMetadataChats.insert(chatId)
        do {
            let result = try await service.refreshChatMetadata(chatId: chatId)
            if let idx = chatMetadata.firstIndex(where: { $0.chat_id == chatId }) {
                chatMetadata[idx] = ChatMetadata(
                    chat_id: result.chat_id,
                    summary: result.summary,
                    last_updated: Date(),
                    chat_name: chatMetadata[idx].chat_name,
                    latest_message_date: chatMetadata[idx].latest_message_date
                )
            }
        } catch {
            // Silently fail — user can retry
        }
        refreshingMetadataChats.remove(chatId)
    }

    // MARK: - Actions

    @MainActor
    func loadActions() async {
        isLoadingActions = true
        do {
            actions = try await service.fetchActions()
        } catch {
            actions = []
        }
        isLoadingActions = false
    }

    @MainActor
    func loadCompletedActions() async {
        do {
            completedActions = try await service.fetchActions(includeCompleted: true)
                .filter { $0.completed }
        } catch {
            completedActions = []
        }
    }

    @MainActor
    func completeAction(id: Int) async {
        do {
            try await service.completeAction(id: id)
            if let action = actions.first(where: { $0.id == id }) {
                completedActions.insert(action, at: 0)
            }
            actions.removeAll { $0.id == id }
        } catch {
            // Silently fail — user can retry
        }
    }

    // MARK: - Settings

    func fetchSettings() async throws -> SearchService.SettingsResponse {
        try await service.fetchSettings()
    }

    func fetchModels() async throws -> [SearchService.ModelOption] {
        try await service.fetchModels()
    }

    func updateSettings(_ updates: [String: String]) async throws {
        try await service.updateSettings(updates)
    }

    // MARK: - Context

    @MainActor
    func toggleContext(for result: SearchResult) async {
        if expandedResults.contains(result.id) {
            expandedResults.remove(result.id)
            return
        }

        expandedResults.insert(result.id)

        if contextMessages[result.id] != nil { return }

        loadingContext.insert(result.id)
        do {
            let messages = try await service.fetchContext(messageId: result.id)
            contextMessages[result.id] = messages
        } catch {
            contextMessages[result.id] = []
        }
        loadingContext.remove(result.id)
    }
}
