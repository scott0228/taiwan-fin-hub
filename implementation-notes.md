# Implementation Notes

## TDCC 信任裝置注入 admin route

目標:讓使用者把已通過集保驗證的裝置識別(`deviceId` + `devType`,例如從 iOS
App 擷取的值)寫入集保 connector 設定,之後同步可重用該信任裝置、略過 OTP。
取代先前的一次性 scratchpad 腳本 + `wrangler --remote` 手動 SQL 流程。

### 端點

- `POST /api/connectors/:connectorId/trusted-device`
- Body:`{ deviceId: string, devType: string, devModel?: string }`
- 回應:`{ connectorId, configured, updatedAt }`
- 沿用既有 `/api` middleware:Cloudflare Access 驗證、demo 唯讀保護、
  `connectorContextMiddleware`(驗證 connectorId)。不新增 auth。

### 行為(`service.ts` 的 `setTdccTrustedDevice`)

1. 僅允許 `tdcc`;其他 connector 回 `INVALID_CONNECTOR_CONFIG`。
2. 需已存在設定且 credential 欄位(userId/password)完整,否則
   `CONNECTOR_CONFIG_MISSING`。
3. 解密現有 config,併入 `deviceId`/`devType`(可選 `devModel`)。
4. 刪除 `session`/`otp`/`otpChannel`:舊 session token 綁定舊 deviceId,保留會
   髒掉;強制下次同步以新信任裝置重新登入。
5. 以 `parseConnectorConfig` 驗證後重新加密寫回。
6. 清空 `sync_cursor`:cursor 內也殘留舊 deviceId/session,清掉確保
   `config.deviceId`(優先權高於 cursor,見 `tdcc/protocol.ts`)乾淨生效。

### 設計決策(spec 未明處)

- **沿用既有 service 檔**:放在 `features/connectors/service.ts`,重用
  `decryptJson`/`encryptJson`/`saveConnectorSettings`/`clearConnectorCursor`,
  不另開 feature slice。符合 AGENTS.md 的 Vertical Slice 與「編輯優先」。
- **deviceId/devType 屬 `secretStateFields`**:本就會留在 encrypted config
  (`sensitiveConnectorConfig` 只濾 publicFields),故無需改 `connector-catalog`。
- **不走既有 `PUT .../settings`**:該路徑雖能注入 secret 欄位,但不會清掉舊
  session,也不清 cursor。專用端點語意明確且行為正確。

### Deviation

- 未在前端加 UI。使用者原先選「直接寫 config(A)」,本次升級為 admin route,
  仍以 API 呼叫為介面;前端表單欄位非本次範圍。

### Tradeoff

- 專用端點 vs 擴充 `updateConnectorSettings`:後者混入 session 清理會讓一般設定
  更新語意變複雜,故獨立。

### 已知風險(沿用先前分析)

- Worker 與手機共用同一 deviceId,若集保限單一 active session,手機 App 可能被
  登出(裝置信任本身不受影響)。
- `devModel` 預設 `SM-G991B`(Android);不進 AES 金鑰,server 多半不驗。登入被
  擋時可帶 iOS 機型字串(如 `iPhone15,3`)。

### Open questions

- 是否要加前端欄位/按鈕觸發此端點?目前僅 API。
- 是否需要在 `getConnectorSettingsView` 回傳「已設定信任裝置」狀態供前端顯示?
