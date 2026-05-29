# Divinci Local Inference — Privacy Policy

_Last updated: 2026-05-29_

The Divinci Local Inference Chrome extension does not collect, store,
transmit, or sell any personal data. There is no analytics, telemetry,
or remote logging.

## What the extension does

The extension downloads Google's Gemma 4 model from Hugging Face on
first use, caches it in your browser, and runs the model on your
device's GPU when chat.divinci.app sends an inference request through a
`chrome.runtime` port.

## Network access

The extension makes network requests to two destinations:

- **huggingface.co** (and its CDN `cas-bridge.xethub.hf.co`) — to
  download the model files. Subject to Hugging Face's privacy policy at
  https://huggingface.co/privacy.
- **Pages on chat.divinci.app** (and our staging/dev origins) connect
  to the extension via `chrome.runtime` ports — no outbound network
  traffic, just same-machine message passing.

## Data you send to the extension

When chat.divinci.app sends a chat message to the extension for
inference, the message text is passed to the local model and the
generated response is streamed back. The extension does not log, store,
transmit, or persist these messages anywhere outside the model's
transient compute. After the response is returned, the message and
response exist only in the requesting page (chat.divinci.app), which has
its own privacy policy.

## Permissions

- **offscreen** — required to run the WebGPU model.
- **storage** — caches the model-selection preference (a small
  key/value).
- **externally_connectable** — limited to Divinci AI domains; no other
  website can connect.

## Changes to this policy

If we change how the extension handles data, we will update this policy
and bump the extension version. The version is shown on the extension's
`chrome://extensions` card.

## Contact

Questions? Email mike@divinci.ai.

<!--
TODO before CWS submission:
  - Host this text at a public, stable URL (e.g.
    https://divinci.ai/legal/local-inference-privacy) and paste that
    URL into the Chrome Web Store "Privacy policy URL" field. A dead or
    placeholder URL will fail review.
  - Confirm the contact address (mike@divinci.ai) is the one you want
    publicly listed, or swap for a role address (support@ / privacy@).
-->
