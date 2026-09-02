const assert = require('node:assert/strict');
const test = require('node:test');
const { RoomRelay, buildFrame, parseFrame } = require('../src/relay');

test('websocket frame codec handles short and extended payloads', () => {
  for (const value of ['hello', 'x'.repeat(512)]) {
    const frame = buildFrame(0x1, value);
    const parsed = parseFrame(frame);
    assert.equal(parsed.opcode, 0x1);
    assert.equal(parsed.payload.toString(), value);
  }
});

test('room relay creates unique rooms and expires disconnected rooms', () => {
  const relay = new RoomRelay({ roomTtlMs: 10, maxMembers: 2 });
  const first = relay.createRoom({ roomName: 'one' });
  const second = relay.createRoom({ roomName: 'two' });
  assert.notEqual(first.roomCode, second.roomCode);
  assert.equal(relay.cleanup(Date.now() + 100), 2);
  assert.equal(relay.rooms.size, 0);
  relay.close();
});
