import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { setupTest } from 'matterbridge/vitest-utils';
import { addDevice, aggregator, createServerNode, createTestEnvironment, destroyTestEnvironment, flushServerNode } from 'matterbridge/vitest-utils/matter';
import { MatterbridgeCameraPlatform } from './module.js';
import type { MatterbridgeEndpoint } from 'matterbridge';

await setupTest('RtspDoorbellLifecycle');

function testPlatform(): MatterbridgeCameraPlatform {
  const platform = Object.create(MatterbridgeCameraPlatform.prototype) as MatterbridgeCameraPlatform & {
    doorbells: Map<string, MatterbridgeEndpoint>;
    roots: Map<string, MatterbridgeEndpoint>;
    cameraChildren: Map<string, MatterbridgeEndpoint>;
  };
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
    expect(await addDevice(aggregator, root)).toBe(true);
    const button = root.getChildEndpointById('Doorbell');
    expect(button).toBeDefined();
    expect(root.lifecycle.isInstalled).toBe(true);
    expect(button!.lifecycle.isInstalled).toBe(true);
    expect(await button!.triggerSwitchEvent('Single', button!.log)).toBe(true);
  });
});
