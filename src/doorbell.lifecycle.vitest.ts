import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { setupTest } from 'matterbridge/vitest-utils';
import { addDevice, aggregator, createServerNode, createTestEnvironment, destroyTestEnvironment, flushServerNode } from 'matterbridge/vitest-utils/matter';
import { MatterbridgeCameraPlatform } from './module.js';
import type { MatterbridgeEndpoint } from 'matterbridge';

await setupTest('RtspDoorbellLifecycle');

function testPlatform(): MatterbridgeCameraPlatform {
  const platform = Object.create(MatterbridgeCameraPlatform.prototype);
  platform.config = { debug: false };
  platform.doorbells = new Map();
  platform.roots = new Map();
  platform.cameraChildren = new Map();
  return platform;
}

describe('RTSP VideoDoorbell real Matter lifecycle', () => {
  beforeAll(async () => {
    await createTestEnvironment();
    await createServerNode(6091);
  });
  afterAll(async () => {
    await flushServerNode();
    await destroyTestEnvironment();
  });
  it('installs the composite endpoint and can emit a Single doorbell event', async () => {
    const platform = testPlatform();
    const root: MatterbridgeEndpoint = platform.createCameraEndpoint({ id: 'urmet-test', name: 'Urmet Test', rtspUrl: 'rtsp://example.invalid/live', videoDoorbell: true });
    const button = platform.doorbells.get('urmet-test')!;
    expect(button).toBeDefined();
    expect(await addDevice(aggregator, root)).toBe(true);
    expect(root.lifecycle.isInstalled).toBe(true);
    expect(button.lifecycle.isInstalled).toBe(true);
    expect(await button.triggerSwitchEvent('Single', button.log)).toBe(true);
  });
});
