import Foundation

struct ActionItem: Identifiable, Decodable {
    let id: Int
    let chat_id: Int
    let created_at: Date
    let due_date: Date?
    let action_descriptor: String
    let completed: Bool
    let chat_name: String?
    let message_id: Int?
}
