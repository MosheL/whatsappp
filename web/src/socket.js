import { ref } from 'vue'

// Single WebSocket connection shared by the app: owns the socket lifecycle,
// auto-reconnect, and the heartbeat that detects half-open connections.
export const wsState = ref('מנותק')

let ws = null
let eventHandler = null
let reconnectTimer
let heartbeatTimer
let awaitingPong = false
let intentionalClose = false

export function connectSocket(handler) {
  if (handler) eventHandler = handler
  intentionalClose = false
  ws?.close()
  clearTimeout(reconnectTimer)
  wsState.value = 'מתחבר'
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${protocol}//${location.host}/ws`)
  const socket = ws
  ws.onopen = () => {
    if (ws !== socket) return
    wsState.value = 'מחובר'
    awaitingPong = false
  }
  ws.onmessage = event => {
    if (ws !== socket) return
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    if (data.type === 'pong') {
      awaitingPong = false
      return
    }
    eventHandler?.(data)
  }
  ws.onclose = () => {
    if (ws !== socket) return
    wsState.value = 'מנותק'
    if (!intentionalClose) reconnectTimer = setTimeout(() => connectSocket(), 2000)
  }
  ws.onerror = () => {
    if (ws !== socket) return
    wsState.value = 'שגיאה'
  }
  startHeartbeat()
}

export function disconnectSocket() {
  intentionalClose = true
  clearTimeout(reconnectTimer)
  clearInterval(heartbeatTimer)
  awaitingPong = false
  const socket = ws
  ws = null
  socket?.close()
  wsState.value = 'מנותק'
}

export function isOpen() {
  return Boolean(ws && ws.readyState === WebSocket.OPEN)
}

export function isClosed() {
  return !ws || ws.readyState === WebSocket.CLOSED
}

// Detects a half-open socket (client freeze / network drop with no close
// event): if the previous ping got no pong by the next tick, the connection
// is dead — close it so the reconnect cycle restarts and the session resyncs.
function startHeartbeat() {
  clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      awaitingPong = false
      return
    }
    if (awaitingPong) {
      awaitingPong = false
      ws.close()
      return
    }
    awaitingPong = true
    try { ws.send(JSON.stringify({ type: 'ping' })) } catch { }
  }, 15000)
}
