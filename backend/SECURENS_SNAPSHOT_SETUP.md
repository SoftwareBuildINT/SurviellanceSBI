# Securens Base64 snapshot integration

The dashboard's Securens path now returns camera snapshots instead of HLS/RTSP
video. It uses the existing Securens login and site-list endpoints as the DVR
configuration lookup (API 1), then calls the HawkAI multi-image endpoint (API 2).
The document does not specify a separate DVR-details URL, so no new upstream
route is invented.

## Server environment

Configure these variables in the backend's protected environment (for example,
the server-side `.env`). Do not commit real values or return them to the browser.

```dotenv
SECURENS_LOGIN=<existing Securens login URL>
SECURENS_SITE_LIST=<existing Securens site-list URL prefix>
SECURENS_USERNAME=<Securens service-account email>
SECURENS_PASSWORD=<Securens service-account password>
HAWKAI_MULTI_STREAM_IMAGES_URL=https://algoaiotapi.cms.com/multi_stream_images
HAWKAI_API_TOKEN=<HawkAI API token, without the Bearer prefix>
# Set only if Securens site_config does not return these assigned ports:
HAWKAI_DVR_PORT=<DVR port assigned by the DVR/HawkAI integration owner>
HAWKAI_SUPPORT_PORT=<support port assigned by the DVR/HawkAI integration owner>
```

`SECURENS_LIVE_STREAM` is no longer called by the snapshot flow.

## DVR configuration expected from Securens

For the selected ATM, the first `site_config` record must provide:

| HawkAI field | Securens `site_config` source |
| --- | --- |
| `dvrip` | `dvr_ip` |
| `dvrport` | `dvr_port`, or the server-side `HAWKAI_DVR_PORT` fallback |
| `support_port` | `support_port`, or the server-side `HAWKAI_SUPPORT_PORT` fallback |
| `username` | `dvr_user_id` |
| `password` | `dvr_password` |
| `dvrmodel` | `dvr_manufacturer` |
| `camera_channel` | comma-separated `camera_num` |
| `methodforsnap` | `methodforsnap`, defaulting to `SDK` per the document |

The configured Securens login response must contain `token` and `services[0]`;
the site-list response must contain a `data` array with `siteId` and
`site_config`. The HawkAI API must accept JSON with the mapped fields and return
Base64 image strings keyed by channel (as described in the technical document).

If Securens does not supply `dvr_port`/`support_port`, confirm their values and
meaning with Securens/HawkAI before setting the fallbacks. Do not assume the
RTSP port is also a DVR or support/API port.
