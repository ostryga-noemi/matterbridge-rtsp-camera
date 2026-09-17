# Experimental Matter Video Doorbell + external ring

This branch adds an optional composed Matter Video Doorbell (0x0143) with
Camera (0x0142) and Doorbell (0x0148) children. The Doorbell includes the
momentary Switch server and required Chime client. `ring` uses Matterbridge's
single-press helper (InitialPress followed by release and reset).

Ordinary cameras and HomeKit publication retain their existing behavior.
The new feature is Matter-only; requesting it in HomeKit mode is an error.
The parent retains the configured ID and serial number. The camera child also
uses the configured ID within its parent, preserving go2rtc stream lookup.
No shared go2rtc stream definitions are changed.

## Configuration

Merge these settings into the plugin configuration. Replace the example stream
and token; do not commit real credentials. Generate a token with
`openssl rand -hex 32`.

```json
{
  "mode": "matter",
  "go2rtcUrl": "http://127.0.0.1:1984",
  "cameras": [
    {
      "id": "urmet",
      "name": "Urmet",
      "rtspUrl": "rtsp://YOUR_STREAM_HOST/YOUR_STREAM_PATH",
      "videoDoorbell": true
    }
  ],
  "ringServer": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 8787,
    "token": "REPLACE_WITH_A_RANDOM_TOKEN_OF_AT_LEAST_32_CHARACTERS",
    "cooldownMs": 1000
  }
}
```

The HTTP listener is off by default. It binds to loopback by default. To call
from a separate Home Assistant host, select a reachable local interface and
publish the port if using containers. Keep it on a trusted local network;
use a TLS reverse proxy for untrusted networks. The token is sent in an HTTP
header, not the URL. No GET trigger or browser CORS access is provided.

Changing an already-paired camera's endpoint composition may require removing
and pairing the test device again. Back up the current configuration first.
Do not assume an existing controller will rediscover changed child endpoints.

## Manual trigger

```sh
curl --fail-with-body -X POST \
  -H "Authorization: Bearer $RING_TOKEN" \
  http://127.0.0.1:8787/api/cameras/urmet/ring
```

Use a URL-encoded camera ID in the path. No request body is needed.

| HTTP status | Meaning |
| --- | --- |
| 200 | Matterbridge accepted the single-press operation |
| 400 | Malformed encoded camera ID |
| 401 | Missing or incorrect bearer token |
| 404 | Unknown route, unknown camera, or camera not in Video Doorbell mode |
| 405 | Method other than POST |
| 429 | Same camera is already ringing or inside its cooldown |
| 503 | Endpoint not ready, shutting down, or event dispatch failed |

A 200 response is **not** confirmation of SmartThings delivery or a TV popup.
Simultaneous calls for one camera are rejected; other cameras are independent.
Cooldown applies only after a successful dispatch. Failed requests can retry.

## Home Assistant example

In `secrets.yaml`, set `urmet_ring_authorization` to the full string
`Bearer YOUR_RANDOM_TOKEN`.

```yaml
rest_command:
  urmet_matter_ring:
    url: "http://MATTERBRIDGE_HOST:8787/api/cameras/urmet/ring"
    method: POST
    headers:
      Authorization: !secret urmet_ring_authorization
    timeout: 10
```

Call `rest_command.urmet_matter_ring` from the existing physical Urmet ring
automation. This branch does not invent an Urmet entity ID or trigger schema.

## Installation and testing

Requires Matterbridge 3.10.4 or newer and the existing go2rtc setup.
Once this branch is pushed to a fork, clone that fork and check out
`feature/video-doorbell-external-ring`, then run:

```sh
npm ci
npm test
npm pack
```

The package keeps the upstream plugin name so it can replace the installed
plugin; do not run two copies simultaneously. Build/test before installing the
produced archive using your Matterbridge installation's supported plugin flow.
Retain the original package/configuration to roll back.

Hardware acceptance remains required:

1. Pair the test device with SmartThings and inspect parent and child types.
2. Verify live view and snapshots before sending any ring event.
3. Send the authenticated POST and check Matter logs for a single press.
4. Check whether SmartThings recognizes the ring and whether the Samsung TV
   offers and displays a camera notification.
5. Connect the existing physical-ring automation only after these checks pass.

SmartThings/Samsung support for this composed Matter device is unverified.
This is an experimental implementation, not a promise of a working TV popup.

## Validation of this preparation

- `npm test`: passed; upstream direct-source test plus five new tests.
- Production bundle: built successfully against Matterbridge 3.10.4.
- `tsc --noEmit`: fails with the same 16 pre-existing strict-null diagnostics
  reproduced on unmodified upstream commit `c000830`; no new diagnostics.
- No physical RTSP camera, Matter controller or Samsung television was tested.
- The GitHub connector exposed file/branch writes but no fork-creation action.
  This archive is prepared locally; no remote fork or pull request was created.

## Home Assistant package persistence

This experimental fork sets `private: true` in package.json so Matterbridge can
restore it from the uploaded tarball instead of npm when the add-on container
is recreated. After uploading over an already running upstream plugin, restart
only the camera plugin from its Actions row first. Confirm version
`0.3.1-doorbell.2` before restarting the entire add-on; this saves the private
package metadata used for recovery.
