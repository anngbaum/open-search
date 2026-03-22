import SwiftUI

struct SettingsView: View {
    @Bindable var viewModel: SearchViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var anthropicKeyInput: String = ""
    @State private var openaiKeyInput: String = ""
    @State private var selectedModel: String = ""
    @State private var models: [SearchService.ModelOption] = []
    @State private var maskedAnthropicKey: String? = nil
    @State private var maskedOpenaiKey: String? = nil
    @State private var isSaving: Bool = false
    @State private var isLoading: Bool = true
    @State private var statusMessage: String? = nil

    private var availableModels: [SearchService.ModelOption] {
        models.filter { $0.available }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Settings")
                .font(.headline)

            if isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(alignment: .leading, spacing: 16) {
                    apiKeySection(
                        title: "Anthropic API Key",
                        placeholder: "sk-ant-...",
                        input: $anthropicKeyInput,
                        maskedKey: maskedAnthropicKey,
                        helpText: "console.anthropic.com"
                    )

                    apiKeySection(
                        title: "OpenAI API Key",
                        placeholder: "sk-...",
                        input: $openaiKeyInput,
                        maskedKey: maskedOpenaiKey,
                        helpText: "platform.openai.com"
                    )

                    Divider()

                    modelPicker
                }

                if let status = statusMessage {
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(status.contains("Error") ? .red : .green)
                }
            }

            Spacer()

            HStack {
                Spacer()
                Button("Cancel") {
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
                Button("Save") {
                    Task { await save() }
                }
                .disabled(isSaving)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 460, height: 380)
        .task { await loadSettings() }
    }

    private func apiKeySection(
        title: String,
        placeholder: String,
        input: Binding<String>,
        maskedKey: String?,
        helpText: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.subheadline)
                .foregroundStyle(.secondary)

            SecureField(placeholder, text: input)
                .textFieldStyle(.roundedBorder)

            if let masked = maskedKey, input.wrappedValue.isEmpty {
                Text("Current: \(masked)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text(helpText)
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    private var modelPicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Model")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            if availableModels.isEmpty {
                Text("Enter at least one API key to select a model.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            } else {
                Picker("", selection: $selectedModel) {
                    ForEach(availableModels) { model in
                        Text(model.name).tag(model.id)
                    }
                }
                .labelsHidden()
            }
        }
    }

    private func loadSettings() async {
        isLoading = true
        do {
            async let settingsReq = viewModel.fetchSettings()
            async let modelsReq = viewModel.fetchModels()
            let (settings, fetchedModels) = try await (settingsReq, modelsReq)

            maskedAnthropicKey = settings.anthropicApiKey
            maskedOpenaiKey = settings.openaiApiKey
            models = fetchedModels
            selectedModel = settings.selectedModel ?? fetchedModels.first(where: { $0.available })?.id ?? ""
        } catch {
            statusMessage = "Error loading settings"
        }
        isLoading = false
    }

    private func save() async {
        isSaving = true
        statusMessage = nil

        var updates: [String: String] = [:]

        if !anthropicKeyInput.isEmpty {
            updates["anthropicApiKey"] = anthropicKeyInput
        }
        if !openaiKeyInput.isEmpty {
            updates["openaiApiKey"] = openaiKeyInput
        }
        if !selectedModel.isEmpty {
            updates["selectedModel"] = selectedModel
        }

        guard !updates.isEmpty else {
            isSaving = false
            dismiss()
            return
        }

        do {
            try await viewModel.updateSettings(updates)

            // Update masked displays
            if !anthropicKeyInput.isEmpty {
                maskedAnthropicKey = maskKey(anthropicKeyInput)
                anthropicKeyInput = ""
            }
            if !openaiKeyInput.isEmpty {
                maskedOpenaiKey = maskKey(openaiKeyInput)
                openaiKeyInput = ""
            }

            // Refresh models availability
            if let fetchedModels = try? await viewModel.fetchModels() {
                models = fetchedModels
                // If current selection is no longer available, pick first available
                if !availableModels.contains(where: { $0.id == selectedModel }) {
                    selectedModel = availableModels.first?.id ?? ""
                }
            }

            statusMessage = "Saved"
        } catch {
            statusMessage = "Error saving settings"
        }

        isSaving = false
    }

    private func maskKey(_ key: String) -> String {
        key.count > 12
            ? String(key.prefix(7)) + "..." + String(key.suffix(4))
            : "***"
    }
}
