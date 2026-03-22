import Foundation

struct ChatMetadata: Identifiable, Decodable {
    let chat_id: Int
    let summary: String
    let last_updated: Date
    let chat_name: String?
    let latest_message_date: Date?

    var id: Int { chat_id }
}
