(function () {
  "use strict";

  const MIN_CHUNK_SIZE = 8;

  const elements = {
    qrStage: document.querySelector(".qr-stage"),
    qrCode: document.getElementById("qr-code"),
    qrCaption: document.getElementById("qr-caption"),
    qrProgress: document.getElementById("qr-progress"),
    modeSummary: document.getElementById("mode-summary"),
    modeButtons: Array.from(document.querySelectorAll("[data-mode]")),
    focusCamera: document.getElementById("focus-camera"),
    senderPanel: document.getElementById("sender-panel"),
    receiverPanel: document.getElementById("receiver-panel"),
    cameraStatus: document.getElementById("camera-status"),
    cameraPreview: document.getElementById("camera-preview"),
    qrCameraPreview: document.getElementById("qr-camera-preview"),
    scanCanvas: document.getElementById("scan-canvas"),
    senderText: document.getElementById("sender-text"),
    senderFile: document.getElementById("sender-file"),
    senderSourceHint: document.getElementById("sender-source-hint"),
    baseChunkSize: document.getElementById("base-chunk-size"),
    maxChunkSize: document.getElementById("max-chunk-size"),
    ackTimeoutMs: document.getElementById("ack-timeout-ms"),
    startSend: document.getElementById("start-send"),
    stopSend: document.getElementById("stop-send"),
    senderStatus: document.getElementById("sender-status"),
    receiverStatus: document.getElementById("receiver-status"),
    receiverOutput: document.getElementById("receiver-output"),
    receiverFileMeta: document.getElementById("receiver-file-meta"),
    downloadReceived: document.getElementById("download-received"),
    resetReceiver: document.getElementById("reset-receiver"),
    eventLog: document.getElementById("event-log"),
  };

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const scanContext = elements.scanCanvas.getContext("2d", { willReadFrequently: true });

  if (window.qrcode && window.qrcode.stringToBytesFuncs && window.qrcode.stringToBytesFuncs["UTF-8"]) {
    window.qrcode.stringToBytes = window.qrcode.stringToBytesFuncs["UTF-8"];
  }

  const state = {
    mode: "sender",
    stream: null,
    scanLoopId: null,
    scanLock: false,
    lastScannedValue: "",
    lastScannedAt: 0,
    barcodeDetector: null,
    scannerLabel: "jsQR fallback",
    wakeLock: null,
    wakeLockSupported: "wakeLock" in navigator,
    wakeLockNoticeShown: false,
    sender: createSenderState(),
    receiver: createReceiverState(),
  };

  function createSenderState() {
    return {
      isSending: false,
      bytes: null,
      transferId: "",
      transferChecksum: "",
      transferKind: "text",
      transferMeta: null,
      seq: 0,
      cursor: 0,
      currentTargetChunkSize: 96,
      currentActualChunkSize: 0,
      baseChunkSize: 96,
      maxChunkSize: 768,
      ackTimeoutMs: 3000,
      currentPacketText: "",
      currentChunkChecksum: "",
      currentChunkIsFinal: false,
      ackDeadlineId: null,
      lastSentAt: 0,
      lastRoundTripMs: null,
      stableSuccessCount: 0,
    };
  }

  function createReceiverState() {
    return {
      activeTransferId: "",
      transferKind: "text",
      transferMeta: null,
      expectedSeq: 0,
      chunks: [],
      ackMap: new Map(),
      completed: false,
      transferChecksum: "",
      objectUrl: "",
      outputBytes: null,
    };
  }

  function init() {
    bindEvents();
    setMode("sender");
    resetSenderUi();
    renderPlaceholder("QR output will appear here.");
    updateQrProgress("0.0%");
    updateSenderSourceHint();
    updateReceiverFileUi();
    prepareBarcodeDetector();
    startCamera();
  }

  function bindEvents() {
    elements.modeButtons.forEach((button) => {
      button.addEventListener("click", () => setMode(button.dataset.mode));
    });

    elements.focusCamera.addEventListener("click", focusCameraAtCenter);
    elements.startSend.addEventListener("click", () => {
      startTransfer();
    });
    elements.stopSend.addEventListener("click", () => stopTransfer("Transfer stopped."));
    elements.senderFile.addEventListener("change", updateSenderSourceHint);
    elements.downloadReceived.addEventListener("click", downloadReceivedFile);
    elements.resetReceiver.addEventListener("click", () => {
      resetReceiver(true);
      renderPlaceholder("Receiver ACK QR will appear here.");
    });
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  function setMode(mode) {
    state.mode = mode === "receiver" ? "receiver" : "sender";
    const senderActive = state.mode === "sender";

    if (!senderActive && state.sender.isSending) {
      stopTransfer("Transfer paused because receiver mode was selected.");
    }

    elements.modeButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === state.mode);
    });
    elements.senderPanel.classList.toggle("active-panel", senderActive);
    elements.receiverPanel.classList.toggle("active-panel", !senderActive);
    elements.modeSummary.textContent = senderActive
      ? "Sender mode is active. Send text or a file and wait for ACK QR codes."
      : "Receiver mode is active. Scan chunks, rebuild the payload, and show ACK QR codes back.";

    if (senderActive) {
      updateSenderStatus("Idle.");
      if (!state.sender.isSending) {
        renderPlaceholder("Sender data QR will appear here.");
      }
    } else if (!state.receiver.activeTransferId) {
      updateReceiverStatus("Waiting for the first chunk.");
      renderPlaceholder("Receiver ACK QR will appear here.");
    }

    if (!senderActive) {
      scrollToQrStage();
    }
  }

  function renderPlaceholder(message) {
    elements.qrCode.innerHTML = '<div class="qr-placeholder">' + escapeHtml(message) + "</div>";
    elements.qrCaption.textContent = message;
  }

  function renderQr(text, caption) {
    try {
      const svg = buildQrSvg(text);
      elements.qrCode.innerHTML = svg;
      elements.qrCaption.textContent = caption;
    } catch (error) {
      renderPlaceholder("Unable to render QR: " + String(error));
    }
  }

  function buildQrSvg(text) {
    const qr = qrcode(0, "L");
    qr.addData(text, "Byte");
    qr.make();
    return qr.createSvgTag({
      cellSize: 7,
      margin: 8,
      scalable: true,
      alt: "QR code payload",
      title: "QR transfer payload",
    });
  }

  async function startTransfer() {
    const source = await readTransferSource();
    if (!source) {
      updateSenderStatus("Add text or choose a file before starting a transfer.");
      logEvent("Sender needs text or a file before it can start.");
      return;
    }

    stopTransfer("");

    const baseChunkSize = clampNumber(elements.baseChunkSize.value, 16, 1024, 96);
    const maxChunkSize = clampNumber(elements.maxChunkSize.value, baseChunkSize, 2048, 768);
    const ackTimeoutMs = clampNumber(elements.ackTimeoutMs.value, 1000, 10000, 3000);
    const bytes = source.bytes;

    state.sender = {
      ...createSenderState(),
      isSending: true,
      bytes,
      transferId: makeTransferId(),
      transferChecksum: fnv1aHex(bytes),
      transferKind: source.kind,
      transferMeta: source.meta,
      baseChunkSize,
      maxChunkSize,
      currentTargetChunkSize: baseChunkSize,
      ackTimeoutMs,
    };

    updateSenderStatus(
      "Transfer " +
        state.sender.transferId +
        " started. " +
        bytes.length +
        " bytes queued as " +
        source.label +
        describeCompression(source.meta) +
        "."
    );
    logEvent(
      "Sender started transfer " +
        state.sender.transferId +
      " with " +
        bytes.length +
        " bytes as " +
        source.label +
        describeCompression(source.meta) +
        "."
    );
    syncWakeLock();
    scrollToQrStage();
    updateQrProgress(formatProgress(0, bytes.length));

    showCurrentChunk();
  }

  function scrollToQrStage() {
    if (!elements.qrStage) {
      return;
    }

    elements.qrStage.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  function stopTransfer(message) {
    clearSenderTimeout();
    state.sender.isSending = false;
    state.sender.currentPacketText = "";
    syncWakeLock();

    if (message) {
      updateSenderStatus(message);
      logEvent(message);
    }
  }

  function showCurrentChunk() {
    const sender = state.sender;
    if (!sender.isSending || !sender.bytes) {
      return;
    }

    if (sender.cursor >= sender.bytes.length) {
      sender.isSending = false;
      syncWakeLock();
      renderPlaceholder("Transfer complete. Sender is idle.");
      updateSenderStatus(
        "Transfer complete for " +
          describeTransfer(sender.transferKind, sender.transferMeta) +
          ". Final checksum " +
          sender.transferChecksum +
          "."
      );
      updateQrProgress(formatProgress(sender.bytes.length, sender.bytes.length));
      logEvent(
        "Sender completed transfer " +
          sender.transferId +
          " for " +
          describeTransfer(sender.transferKind, sender.transferMeta) +
          " with checksum " +
          sender.transferChecksum +
          "."
      );
      return;
    }

    const packet = selectChunkPacket();
    if (!packet) {
      stopTransfer("Unable to fit even the minimum chunk size into a QR code.");
      return;
    }

    sender.currentPacketText = packet.text;
    sender.currentActualChunkSize = packet.chunkSize;
    sender.currentChunkChecksum = packet.chunkChecksum;
    sender.currentChunkIsFinal = packet.isFinal;
    sender.lastSentAt = performance.now();

    renderQr(
      packet.text,
      describeTransfer(sender.transferKind, sender.transferMeta) +
        " | data chunk " +
        (sender.seq + 1) +
        " | " +
        packet.chunkSize +
        " bytes | checksum " +
        packet.chunkChecksum
    );

    updateSenderStatus(
      "Sending chunk " +
        (sender.seq + 1) +
        " at " +
        packet.chunkSize +
        " bytes. Timeout retry will keep shrinking the chunk if needed."
    );
    updateQrProgress(formatProgress(sender.cursor, sender.bytes.length));

    scheduleSenderTimeout();
  }

  function selectChunkPacket() {
    const sender = state.sender;
    const remaining = sender.bytes.length - sender.cursor;
    const target = Math.min(sender.currentTargetChunkSize, sender.maxChunkSize, remaining);
    const preferredFloor = Math.min(sender.baseChunkSize, remaining);
    let candidate = target;

    while (candidate >= MIN_CHUNK_SIZE) {
      const packet = buildDataPacket(candidate);
      if (packet) {
        return packet;
      }

      if (candidate > preferredFloor) {
        candidate = Math.max(preferredFloor, Math.floor(candidate / 2));
      } else if (candidate > MIN_CHUNK_SIZE) {
        candidate = Math.max(MIN_CHUNK_SIZE, candidate - MIN_CHUNK_SIZE);
      } else {
        break;
      }
    }

    return null;
  }

  function buildDataPacket(chunkSize) {
    const sender = state.sender;
    const end = Math.min(sender.bytes.length, sender.cursor + chunkSize);
    const chunk = sender.bytes.slice(sender.cursor, end);
    const chunkChecksum = fnv1aHex(chunk);
    const isFinal = end >= sender.bytes.length;
    const transferChecksum = isFinal ? sender.transferChecksum : "-";
    const payload = bytesToBase64Url(chunk);
    const text = [
      "D",
      sender.transferId,
      sender.seq,
      isFinal ? "1" : "0",
      chunkChecksum,
      transferChecksum,
      sender.transferKind,
      encodeTransferMeta(sender.transferMeta),
      payload,
    ].join(".");

    try {
      buildQrSvg(text);
      return {
        text,
        chunkSize: chunk.length,
        chunkChecksum,
        isFinal,
      };
    } catch (_error) {
      return null;
    }
  }

  function scheduleSenderTimeout() {
    clearSenderTimeout();
    state.sender.ackDeadlineId = window.setTimeout(() => {
      if (!state.sender.isSending || !state.sender.currentPacketText) {
        return;
      }

      state.sender.currentTargetChunkSize = Math.max(
        MIN_CHUNK_SIZE,
        Math.floor(state.sender.currentActualChunkSize / 2)
      );
      state.sender.stableSuccessCount = 0;
      updateSenderStatus(
        "ACK timeout. Replaying chunk " +
          (state.sender.seq + 1) +
          " at " +
          state.sender.currentTargetChunkSize +
          " bytes."
      );
      updateQrProgress(formatProgress(state.sender.cursor, state.sender.bytes.length));
      logEvent(
        "Chunk " +
          (state.sender.seq + 1) +
          " timed out after " +
          state.sender.ackTimeoutMs +
          "ms. Rebuilding a smaller QR payload for the same chunk."
      );
      showCurrentChunk();
    }, state.sender.ackTimeoutMs);
  }

  function clearSenderTimeout() {
    if (state.sender.ackDeadlineId) {
      window.clearTimeout(state.sender.ackDeadlineId);
      state.sender.ackDeadlineId = null;
    }
  }

  function handleAckPacket(packet) {
    const sender = state.sender;
    if (!sender.isSending || packet.id !== sender.transferId) {
      return;
    }

    if (packet.seq !== sender.seq) {
      return;
    }

    clearSenderTimeout();
    sender.lastRoundTripMs = Math.round(performance.now() - sender.lastSentAt);

    if (packet.status === "done" && packet.transferChecksum && packet.transferChecksum !== sender.transferChecksum) {
      stopTransfer("Final checksum mismatch after ACK. Transfer halted.");
      return;
    }

    const acceptedSize = packet.acceptedSize || sender.currentActualChunkSize;
    sender.stableSuccessCount += 1;

    let nextTarget = acceptedSize;
    let growthMode = "Holding steady";

    if (sender.stableSuccessCount >= 3 && acceptedSize < sender.maxChunkSize) {
      nextTarget = Math.min(
        Math.max(acceptedSize * 2, sender.baseChunkSize),
        sender.maxChunkSize
      );
      sender.stableSuccessCount = 0;
      growthMode = "Probing upward";
    }

    sender.cursor += acceptedSize;
    sender.seq += 1;
    sender.currentTargetChunkSize = nextTarget;

    updateSenderStatus(
      "ACK " +
        packet.status.toUpperCase() +
        " for chunk " +
        packet.seq +
        " in " +
        sender.lastRoundTripMs +
        "ms. " +
        growthMode +
        ". Next target chunk size is " +
        sender.currentTargetChunkSize +
        " bytes."
    );
    updateQrProgress(formatProgress(sender.cursor, sender.bytes.length));
    logEvent(
      "Sender received ACK for chunk " +
        packet.seq +
        " in " +
        sender.lastRoundTripMs +
        "ms."
    );

    showCurrentChunk();
  }

  function handleDataPacket(packet) {
    void handleDataPacketAsync(packet);
  }

  async function handleDataPacketAsync(packet) {
    const receiver = state.receiver;
    const payloadBytes = base64UrlToBytes(packet.payload);

    if (fnv1aHex(payloadBytes) !== packet.chunkChecksum) {
      updateReceiverStatus("Chunk checksum mismatch. Waiting for the sender to retry.");
      logEvent("Receiver rejected chunk " + packet.seq + " because its checksum did not match.");
      return;
    }

    if (
      receiver.activeTransferId &&
      receiver.activeTransferId !== packet.id &&
      !receiver.completed &&
      packet.seq !== 0
    ) {
      return;
    }

    if (!receiver.activeTransferId || receiver.activeTransferId !== packet.id) {
      revokeReceiverObjectUrl();
      receiver.activeTransferId = packet.id;
      receiver.transferKind = packet.transferKind;
      receiver.transferMeta = packet.transferMeta;
      receiver.expectedSeq = 0;
      receiver.chunks = [];
      receiver.ackMap = new Map();
      receiver.completed = false;
      receiver.transferChecksum = "";
      receiver.objectUrl = "";
      receiver.outputBytes = null;
      elements.receiverOutput.value = "";
      updateReceiverFileUi();
      syncWakeLock();
      logEvent("Receiver is now locked to transfer " + packet.id + ".");
    }

    if (packet.seq < receiver.expectedSeq) {
      const cachedAck = receiver.ackMap.get(makeAckKey(packet.seq));
      if (cachedAck) {
        renderQr(
          cachedAck,
          "Replaying ACK for duplicate chunk " + packet.seq + "."
        );
        updateReceiverStatus("Duplicate chunk seen again. Replaying cached ACK.");
      }
      return;
    }

    if (packet.seq > receiver.expectedSeq) {
      updateReceiverStatus(
        "Out-of-order chunk " +
          packet.seq +
          " received. Waiting for chunk " +
          receiver.expectedSeq +
          "."
      );
      return;
    }

    receiver.chunks.push(payloadBytes);
    receiver.expectedSeq += 1;
    updateReceiverPayloadView();

    let ackStatus = "ok";
    let ackTransferChecksum = "";

    if (packet.isFinal) {
      ackTransferChecksum = fnv1aHex(concatChunks(receiver.chunks));
      if (packet.transferChecksum && packet.transferChecksum !== ackTransferChecksum) {
        receiver.chunks.pop();
        receiver.expectedSeq -= 1;
        updateReceiverPayloadView();
        updateReceiverStatus("Final checksum mismatch. Waiting for the sender to replay the last chunk.");
        logEvent("Receiver detected a final checksum mismatch for chunk " + packet.seq + ".");
        return;
      }

      try {
        receiver.outputBytes = await maybeDecompressPayload(
          concatChunks(receiver.chunks),
          receiver.transferMeta
        );
      } catch (error) {
        updateReceiverStatus("Transfer received, but decompression failed: " + error.message);
        logEvent("Receiver could not decompress the completed payload: " + error.message);
        return;
      }

      receiver.completed = true;
      receiver.transferChecksum = ackTransferChecksum;
      updateReceiverPayloadView();
      if (receiver.transferKind === "file") {
        receiver.objectUrl = URL.createObjectURL(
          new Blob([receiver.outputBytes], {
            type: (receiver.transferMeta && receiver.transferMeta.mimeType) || "application/octet-stream",
          })
        );
      }
      updateReceiverFileUi();
      ackStatus = "done";
      syncWakeLock();
    }

    const ackText = buildAckPacket({
      id: packet.id,
      seq: packet.seq,
      chunkChecksum: packet.chunkChecksum,
      status: ackStatus,
      transferChecksum: ackTransferChecksum,
      acceptedSize: payloadBytes.length,
    });

    receiver.ackMap.set(makeAckKey(packet.seq), ackText);
    renderQr(
      ackText,
      "ACK " +
        ackStatus.toUpperCase() +
        " for chunk " +
        packet.seq +
        " | checksum " +
        packet.chunkChecksum
    );

    if (receiver.completed) {
      updateReceiverStatus(
        "Transfer complete for " +
          describeTransfer(receiver.transferKind, receiver.transferMeta) +
          ". Final checksum " +
          receiver.transferChecksum +
          "."
      );
      updateQrProgress(formatProgress(getReceivedByteCount(receiver), getExpectedTransferSize(receiver)));
      logEvent(
        "Receiver completed transfer " +
          packet.id +
          " (" +
          describeTransfer(receiver.transferKind, receiver.transferMeta) +
          ")" +
          " with checksum " +
          receiver.transferChecksum +
          "."
      );
    } else {
      updateReceiverStatus(
        "Accepted chunk " +
          packet.seq +
          ". Receiver now expects chunk " +
          receiver.expectedSeq +
          "."
      );
      updateQrProgress(formatProgress(getReceivedByteCount(receiver), getExpectedTransferSize(receiver)));
      logEvent("Receiver accepted chunk " + packet.seq + ".");
    }
  }

  function buildAckPacket({ id, seq, chunkChecksum, status, transferChecksum, acceptedSize }) {
    return [
      "A",
      id,
      seq,
      chunkChecksum,
      status,
      transferChecksum || "-",
      acceptedSize || 0,
    ].join(".");
  }

  function parsePacket(rawValue) {
    const value = rawValue.trim();
    const parts = value.split(".");

    if (parts.length < 6) {
      return null;
    }

    if (parts[0] === "D" && parts.length >= 9) {
      return {
        kind: "data",
        id: parts[1],
        seq: Number(parts[2]),
        isFinal: parts[3] === "1",
        chunkChecksum: parts[4],
        transferChecksum: parts[5] === "-" ? "" : parts[5],
        transferKind: parts[6] || "text",
        transferMeta: decodeTransferMeta(parts[7]),
        payload: parts.slice(8).join("."),
      };
    }

    if (parts[0] === "A" && parts.length >= 7) {
      return {
        kind: "ack",
        id: parts[1],
        seq: Number(parts[2]),
        chunkChecksum: parts[3],
        status: parts[4],
        transferChecksum: parts[5] === "-" ? "" : parts[5],
        acceptedSize: Number(parts[6]),
      };
    }

    return null;
  }

  async function prepareBarcodeDetector() {
    if (!("BarcodeDetector" in window)) {
      elements.cameraStatus.textContent = "Camera is off. Scan engine will use jsQR.";
      return;
    }

    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (!formats.includes("qr_code")) {
        elements.cameraStatus.textContent = "Camera is off. Scan engine will use jsQR.";
        return;
      }

      state.barcodeDetector = new window.BarcodeDetector({ formats: ["qr_code"] });
      state.scannerLabel = "BarcodeDetector";
      elements.cameraStatus.textContent = "Camera is off. Scan engine: BarcodeDetector.";
    } catch (_error) {
      elements.cameraStatus.textContent = "Camera is off. Scan engine will use jsQR.";
    }
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      elements.cameraStatus.textContent = "Camera API is unavailable in this browser context.";
      logEvent("Camera API is unavailable. Use localhost or HTTPS.");
      return;
    }

    stopCamera();

    try {
      const stream = await requestPreferredCameraStream();

      state.stream = stream;
      elements.cameraPreview.srcObject = stream;
      elements.qrCameraPreview.srcObject = stream;
      await applyPreferredCameraSettings(false);
      await elements.cameraPreview.play();
      await elements.qrCameraPreview.play();
      elements.cameraStatus.textContent = "Camera is live. Scan engine: " + state.scannerLabel + ".";
      logEvent("Camera started using " + state.scannerLabel + ".");
      runScanLoop();
    } catch (error) {
      elements.cameraStatus.textContent = "Unable to start the camera: " + error.message;
      logEvent("Camera start failed: " + error.message);
    }
  }

  async function requestPreferredCameraStream() {
    const videoPresets = [
      {
        facingMode: { ideal: "user" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      {
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    ];

    let lastError = null;

    for (const video of videoPresets) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          video,
          audio: false,
        });
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("Unable to access a camera.");
  }

  async function focusCameraAtCenter() {
    if (!getVideoTrack()) {
      elements.cameraStatus.textContent = "Camera is not ready yet.";
      logEvent("Focus request ignored because the camera is not active.");
      return;
    }

    const applied = await applyPreferredCameraSettings(true);
    if (!applied) {
      elements.cameraStatus.textContent = "Center focus is not supported on this device.";
      logEvent("Camera focus controls are unavailable on this browser/device.");
      return;
    }

    elements.cameraStatus.textContent = "Camera refocused at the center of the frame.";
    logEvent("Requested a center focus adjustment on the active camera.");
  }

  async function applyPreferredCameraSettings(triggerRefocus) {
    const track = getVideoTrack();
    if (!track) {
      return false;
    }

    const capabilities = typeof track.getCapabilities === "function" ? track.getCapabilities() : {};
    const constraints = buildPreferredCameraConstraints(capabilities, triggerRefocus);

    if (!constraints) {
      return false;
    }

    try {
      await track.applyConstraints(constraints);
      return true;
    } catch (error) {
      logEvent("Camera constraint update failed: " + error.message);
      return false;
    }
  }

  function buildPreferredCameraConstraints(capabilities, triggerRefocus) {
    const advanced = [];

    if (Array.isArray(capabilities.focusMode)) {
      if (triggerRefocus && capabilities.focusMode.includes("single-shot")) {
        advanced.push({ focusMode: "single-shot" });
      }
      if (capabilities.focusMode.includes("continuous")) {
        advanced.push({ focusMode: "continuous" });
      }
    }

    if (capabilities.pointsOfInterest) {
      advanced.push({ pointsOfInterest: [{ x: 0.5, y: 0.5 }] });
    }

    if (capabilities.zoom && Number.isFinite(capabilities.zoom.min) && Number.isFinite(capabilities.zoom.max)) {
      const zoomTarget = Math.min(capabilities.zoom.max, Math.max(capabilities.zoom.min, 1.25));
      advanced.push({ zoom: zoomTarget });
    }

    if (!advanced.length && triggerRefocus) {
      return null;
    }

    const constraints = {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      resizeMode: "none",
    };

    if (advanced.length) {
      constraints.advanced = advanced;
    }

    return constraints;
  }

  function getVideoTrack() {
    if (!state.stream) {
      return null;
    }

    const [track] = state.stream.getVideoTracks();
    return track || null;
  }

  async function syncWakeLock() {
    if (!state.wakeLockSupported) {
      if (!state.wakeLockNoticeShown && isTransferActive()) {
        state.wakeLockNoticeShown = true;
        logEvent("Wake Lock API is unavailable in this browser. The screen may still dim.");
      }
      return;
    }

    if (!isTransferActive() || document.visibilityState !== "visible") {
      await releaseWakeLock();
      return;
    }

    if (state.wakeLock) {
      return;
    }

    try {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", handleWakeLockRelease, { once: true });
      logEvent("Screen wake lock enabled for the active transfer.");
    } catch (error) {
      logEvent("Wake lock request failed: " + error.message);
    }
  }

  async function releaseWakeLock() {
    if (!state.wakeLock) {
      return;
    }

    const sentinel = state.wakeLock;
    state.wakeLock = null;

    try {
      await sentinel.release();
    } catch (_error) {
      return;
    }
  }

  function handleWakeLockRelease() {
    state.wakeLock = null;
    if (isTransferActive() && document.visibilityState === "visible") {
      syncWakeLock();
    }
  }

  function handleVisibilityChange() {
    syncWakeLock();
  }

  function isTransferActive() {
    return state.sender.isSending || Boolean(state.receiver.activeTransferId && !state.receiver.completed);
  }

  function stopCamera() {
    if (state.scanLoopId) {
      window.clearTimeout(state.scanLoopId);
      state.scanLoopId = null;
    }

    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
      state.stream = null;
    }

    elements.cameraPreview.srcObject = null;
    elements.qrCameraPreview.srcObject = null;
    elements.cameraStatus.textContent = "Camera is off. Scan engine: " + state.scannerLabel + ".";
  }

  function runScanLoop() {
    if (!state.stream || state.scanLoopId) {
      return;
    }

    const step = async () => {
      state.scanLoopId = null;

      if (!state.stream) {
        return;
      }

      if (!state.scanLock) {
        state.scanLock = true;
        try {
          await scanCurrentFrame();
        } finally {
          state.scanLock = false;
        }
      }

      state.scanLoopId = window.setTimeout(step, 120);
    };

    state.scanLoopId = window.setTimeout(step, 120);
  }

  async function scanCurrentFrame() {
    const video = elements.cameraPreview;
    if (video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) {
      return;
    }

    if (state.barcodeDetector) {
      try {
        const barcodes = await state.barcodeDetector.detect(video);
        if (barcodes.length && barcodes[0].rawValue) {
          await consumeScannedValue(barcodes[0].rawValue);
          return;
        }
      } catch (_error) {
        state.barcodeDetector = null;
        state.scannerLabel = "jsQR fallback";
      }
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      return;
    }

    elements.scanCanvas.width = width;
    elements.scanCanvas.height = height;
    scanContext.drawImage(video, 0, 0, width, height);
    const image = scanContext.getImageData(0, 0, width, height);
    const code = window.jsQR
      ? window.jsQR(image.data, image.width, image.height, {
          inversionAttempts: "attemptBoth",
        })
      : null;

    if (code && code.data) {
      await consumeScannedValue(code.data);
    }
  }

  async function consumeScannedValue(rawValue) {
    const now = Date.now();
    if (rawValue === state.lastScannedValue && now - state.lastScannedAt < 400) {
      return;
    }

    state.lastScannedValue = rawValue;
    state.lastScannedAt = now;

    const packet = parsePacket(rawValue);
    if (!packet) {
      return;
    }

    if (state.mode === "sender" && packet.kind === "ack") {
      handleAckPacket(packet);
    } else if (state.mode === "receiver" && packet.kind === "data") {
      await handleDataPacketAsync(packet);
    }
  }

  function resetReceiver(logIt) {
    revokeReceiverObjectUrl();
    state.receiver = createReceiverState();
    elements.receiverOutput.value = "";
    updateReceiverStatus("Waiting for the first chunk.");
    updateQrProgress("0.0%");
    updateReceiverFileUi();
    syncWakeLock();
    if (logIt) {
      logEvent("Receiver state reset.");
    }
  }

  function resetSenderUi() {
    updateSenderStatus("Idle.");
    updateReceiverStatus("Waiting for the first chunk.");
  }

  function updateSenderStatus(message) {
    elements.senderStatus.textContent = message;
  }

  function updateReceiverStatus(message) {
    elements.receiverStatus.textContent = message;
  }

  function updateQrProgress(value) {
    elements.qrProgress.textContent = "Progress: " + value;
  }

  function updateSenderSourceHint() {
    const file = elements.senderFile.files && elements.senderFile.files[0];
    elements.senderSourceHint.textContent = file
      ? 'Selected file: "' + file.name + '" (' + formatByteCount(file.size) + '). This will be sent instead of the text.'
      : "If a file is selected, the transfer sends the file instead of the text above.";
  }

  function updateReceiverPayloadView() {
    const receiver = state.receiver;
    if (receiver.transferKind === "file") {
      const chunkBytes = receiver.outputBytes || concatChunks(receiver.chunks);
      const fileName = receiver.transferMeta && receiver.transferMeta.fileName ? receiver.transferMeta.fileName : "received-file";
      elements.receiverOutput.value =
        "Received file: " +
        fileName +
        "\nBytes buffered: " +
        formatByteCount(chunkBytes.length) +
        (receiver.completed ? "\nStatus: Ready to download." : "\nStatus: Waiting for more chunks.");
      return;
    }

    if (isCompressedTransfer(receiver.transferMeta)) {
      elements.receiverOutput.value = receiver.outputBytes
        ? textDecoder.decode(receiver.outputBytes)
        : "Receiving compressed text...\nCompressed bytes buffered: " + formatByteCount(concatChunks(receiver.chunks).length);
      return;
    }

    elements.receiverOutput.value = decodeChunks(receiver.chunks);
  }

  function updateReceiverFileUi() {
    const receiver = state.receiver;
    const isFile = receiver.transferKind === "file";
    elements.downloadReceived.disabled = !(isFile && receiver.completed && receiver.objectUrl);
    elements.receiverFileMeta.textContent = isFile
      ? buildReceiverFileMeta()
      : "No completed file transfer yet.";
  }

  function buildReceiverFileMeta() {
    const receiver = state.receiver;
    const meta = receiver.transferMeta || {};
    const fileName = meta.fileName || "received-file";
    const mimeType = meta.mimeType || "application/octet-stream";
    const size = receiver.outputBytes ? receiver.outputBytes.length : meta.originalByteLength || concatChunks(receiver.chunks).length;
    return receiver.completed
      ? 'Received file "' + fileName + '" (' + formatByteCount(size) + ", " + mimeType + ') is ready to download.'
      : 'Receiving file "' + fileName + '" (' + formatByteCount(size) + ", " + mimeType + ").";
  }

  function downloadReceivedFile() {
    const receiver = state.receiver;
    if (!receiver.objectUrl || !receiver.completed || receiver.transferKind !== "file") {
      return;
    }

    const anchor = document.createElement("a");
    anchor.href = receiver.objectUrl;
    anchor.download =
      (receiver.transferMeta && receiver.transferMeta.fileName) || "received-file";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }

  function revokeReceiverObjectUrl() {
    if (state.receiver.objectUrl) {
      URL.revokeObjectURL(state.receiver.objectUrl);
      state.receiver.objectUrl = "";
    }
  }

  function logEvent(message) {
    const item = document.createElement("li");
    item.textContent = new Date().toLocaleTimeString() + " - " + message;
    elements.eventLog.prepend(item);

    while (elements.eventLog.children.length > 12) {
      elements.eventLog.removeChild(elements.eventLog.lastChild);
    }
  }

  function decodeChunks(chunks) {
    return textDecoder.decode(concatChunks(chunks));
  }

  async function readTransferSource() {
    const file = elements.senderFile.files && elements.senderFile.files[0];
    if (file) {
      const originalBytes = new Uint8Array(await file.arrayBuffer());
      const compressed = await maybeCompressPayload(originalBytes);
      return {
        kind: "file",
        bytes: compressed.bytes,
        meta: {
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          byteLength: compressed.bytes.length,
          originalByteLength: originalBytes.length,
          compression: compressed.algorithm,
        },
        label: 'file "' + file.name + '"',
      };
    }

    const rawText = elements.senderText.value;
    if (!rawText.trim()) {
      return null;
    }

    const originalBytes = textEncoder.encode(rawText);
    const compressed = await maybeCompressPayload(originalBytes);

    return {
      kind: "text",
      bytes: compressed.bytes,
      meta: {
        byteLength: compressed.bytes.length,
        originalByteLength: originalBytes.length,
        compression: compressed.algorithm,
      },
      label: "text payload",
    };
  }

  function concatChunks(chunks) {
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(length);
    let offset = 0;

    chunks.forEach((chunk) => {
      merged.set(chunk, offset);
      offset += chunk.length;
    });

    return merged;
  }

  function makeTransferId() {
    return "tx" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function encodeTransferMeta(meta) {
    return meta ? bytesToBase64Url(textEncoder.encode(JSON.stringify(meta))) : "-";
  }

  function decodeTransferMeta(value) {
    if (!value || value === "-") {
      return null;
    }

    try {
      return JSON.parse(textDecoder.decode(base64UrlToBytes(value)));
    } catch (_error) {
      return null;
    }
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64UrlToBytes(input) {
    const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
  }

  function fnv1aHex(bytes) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i += 1) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function makeAckKey(seq) {
    return String(seq);
  }

  function describeTransfer(kind, meta) {
    if (kind === "file") {
      return meta && meta.fileName ? 'file "' + meta.fileName + '"' : "file";
    }
    return "text";
  }

  function describeCompression(meta) {
    if (!meta || !meta.compression || meta.compression === "none") {
      return "";
    }

    const originalSize = meta.originalByteLength || meta.byteLength;
    const compressedSize = meta.byteLength || originalSize;
    const savings = originalSize > 0
      ? Math.max(0, 100 - (compressedSize / originalSize) * 100).toFixed(1)
      : "0.0";
    return " using " + meta.compression + " compression (" + savings + "% smaller)";
  }

  function isCompressedTransfer(meta) {
    return Boolean(meta && meta.compression && meta.compression !== "none");
  }

  async function maybeCompressPayload(bytes) {
    if (!("CompressionStream" in window)) {
      return {
        bytes,
        algorithm: "none",
      };
    }

    try {
      return {
        bytes: await transformBytes(bytes, new CompressionStream("gzip")),
        algorithm: "gzip",
      };
    } catch (_error) {
      return {
        bytes,
        algorithm: "none",
      };
    }
  }

  async function maybeDecompressPayload(bytes, meta) {
    if (!isCompressedTransfer(meta)) {
      return bytes;
    }

    if (!("DecompressionStream" in window)) {
      throw new Error("DecompressionStream is unavailable in this browser.");
    }

    return transformBytes(bytes, new DecompressionStream(meta.compression));
  }

  async function transformBytes(bytes, transformer) {
    const stream = new Blob([bytes]).stream().pipeThrough(transformer);
    const resultBuffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(resultBuffer);
  }

  function formatByteCount(byteCount) {
    if (byteCount < 1024) {
      return byteCount + " bytes";
    }
    if (byteCount < 1024 * 1024) {
      return (byteCount / 1024).toFixed(1) + " KB";
    }
    return (byteCount / (1024 * 1024)).toFixed(1) + " MB";
  }

  function formatProgress(done, total) {
    if (!total) {
      return "0%";
    }
    return Math.min(100, Math.max(0, (done / total) * 100)).toFixed(1) + "%";
  }

  function getReceivedByteCount(receiver) {
    return concatChunks(receiver.chunks).length;
  }

  function getExpectedTransferSize(receiver) {
    return receiver.transferMeta && Number.isFinite(receiver.transferMeta.byteLength)
      ? receiver.transferMeta.byteLength
      : getReceivedByteCount(receiver);
  }

  function escapeHtml(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  window.addEventListener("beforeunload", () => {
    stopTransfer("");
    revokeReceiverObjectUrl();
    stopCamera();
  });

  init();
})();
