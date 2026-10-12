# Unchanged Android compatibility contract

Upstream revision: `b4527e8a572eb0d12ca1b75ad5ee2f25a94808ca`.

Contracts come from `android/app/src/main/java/com/httpsms/HttpSmsApiService.kt`, `Models.kt`, `Constants.kt`, `FirebaseMessagingService.kt`, and the sent/delivered receivers. Requests use `x-api-key`; the optional `X-Client-Version` header is accepted.

| Existing Android request | Gateway behavior |
| --- | --- |
| `PUT /v1/phones/fcm-token` with `phone_number`, `sim`, `fcm_token` | Update only the provisioned device token; return `{status,message,data:{id,user_id}}` |
| `POST /v1/heartbeats` with `phone_numbers`, `charging` | Store last-seen and charging state for the provisioned number |
| `GET /v1/messages/outstanding?message_id=UUID` | Atomically claim a pending message and return the Kotlin model in `data` |
| `POST /v1/messages/UUID/events` with `event_name`, `timestamp`, `reason` | Persist `SENT`, `DELIVERED`, or `FAILED` without regressing success |
| `POST /v1/messages/UUID.part/events` | Verify ownership; ignore intermediate SMS parts with `204` |
| `POST /v1/messages/receive` | Return `410`, without storing inbound SMS |
| `POST /v1/messages/calls/missed` | Return `410`, without storing missed calls |

FCM uses `KEY_MESSAGE_ID`, normal priority, and a data-only message with the remaining lifetime as its TTL. The phone fetches content through the API. No custom polling or Android changes are needed for these contracts.

Required Kotlin fields: `contact`, `content`, `sim`, `created_at`, `failure_reason`, `id`, `last_attempted_at`, `order_timestamp`, `owner`, `received_at`, `encrypted`, `request_received_at`, `send_time`, `sent_at`, `status`, `type`, and `updated_at`. Nullable constructor fields are explicitly present. `attachments` is null, `encrypted` is false, and `type` is `mobile-terminated`. `send_time` uses nanoseconds as upstream does.

Event timestamps accept RFC3339 with up to nine fractional digits and an offset; storage uses millisecond-precision ISO timestamps. Intermediate multipart callback handling follows the upstream final-part status behavior. The delivered receiver's explicit `CANNOT BE DELIVERED` reason records a delivery failure even after a `SENT` event; later duplicate send events preserve that failure.

Firebase project compatibility is separate from HTTP compatibility. Backend credentials must be authorized for the project used by the APK. Changing its login server URL does not change that Firebase project.

Contract tests simulate the complete HTTP flow and required model fields. Physical SMS verification needs deployment, matching Firebase configuration, and a real phone.
