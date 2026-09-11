import { extensionOf, outputName } from './conversion-utils.js';

const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
const MAX_MEDIA_SOURCE_BYTES = 250 * 1024 * 1024;
const MAX_WAV_OUTPUT_BYTES = 250 * 1024 * 1024;
const MAX_VIDEO_PIXELS = 30_000_000;
const MAX_VIDEO_DIMENSION = 8192;

function mediaKind(record) {
  const type = String(record?.type || '').toLowerCase();
  const ext = extensionOf(record?.name);
  if (type.startsWith('audio/') || AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (type.startsWith('video/') || VIDEO_EXTENSIONS.has(ext)) return 'video';
  return null;
}

function waitForMedia(element, eventName, errorMessage) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      element.removeEventListener(eventName, onReady);
      element.removeEventListener('error', onError);
    };
    const onReady = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error(errorMessage)); };
    element.addEventListener(eventName, onReady, { once: true });
    element.addEventListener('error', onError, { once: true });
  });
}

async function inspectElement(record, kind) {
  const url = URL.createObjectURL(record.blob);
  const element = document.createElement(kind === 'video' ? 'video' : 'audio');
  element.preload = 'metadata';
  element.muted = true;
  element.playsInline = true;
  try {
    const ready = waitForMedia(element, 'loadedmetadata', `The browser could not read this ${kind} file.`);
    element.src = url;
    element.load();
    await ready;
    return {
      kind,
      duration: Number.isFinite(element.duration) ? element.duration : null,
      width: kind === 'video' ? element.videoWidth : null,
      height: kind === 'video' ? element.videoHeight : null
    };
  } finally {
    element.removeAttribute('src');
    element.load();
    URL.revokeObjectURL(url);
  }
}

function writeAscii(view, offset, value) {
  for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
}

function encodeWav(buffer, channelsMode = 'keep') {
  const sourceChannels = buffer.numberOfChannels;
  const channels = channelsMode === 'mono' ? 1 : sourceChannels;
  const frames = buffer.length;
  const dataBytes = frames * channels * 2;
  const totalBytes = 44 + dataBytes;
  if (totalBytes > MAX_WAV_OUTPUT_BYTES) throw new Error('The decoded WAV would be larger than 250 MB. Try a shorter audio file.');

  const output = new ArrayBuffer(totalBytes);
  const view = new DataView(output);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  const source = Array.from({ length: sourceChannels }, (_, index) => buffer.getChannelData(index));
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    if (channelsMode === 'mono') {
      let sample = 0;
      for (let channel = 0; channel < sourceChannels; channel += 1) sample += source[channel][frame] || 0;
      sample /= Math.max(1, sourceChannels);
      sample = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    } else {
      for (let channel = 0; channel < channels; channel += 1) {
        let sample = Math.max(-1, Math.min(1, source[channel][frame] || 0));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }
  }
  return new Blob([output], { type: 'audio/wav' });
}

async function audioToWav(record, options) {
  if (record.size > MAX_MEDIA_SOURCE_BYTES) throw new Error('Media conversion is limited to 250 MB source files.');
  const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextCtor) throw new Error('This browser does not provide the Web Audio decoder BoxIt needs.');
  const context = new AudioContextCtor();
  try {
    const decoded = await context.decodeAudioData(await record.blob.arrayBuffer());
    const blob = encodeWav(decoded, options.audioChannels === 'mono' ? 'mono' : 'keep');
    const duration = decoded.duration || (decoded.length / decoded.sampleRate);
    return {
      blob,
      name: outputName(record, 'wav'),
      summary: `WAV · ${decoded.sampleRate} Hz · ${options.audioChannels === 'mono' ? 'mono' : `${decoded.numberOfChannels} ch`} · ${duration.toFixed(1)}s`
    };
  } catch (error) {
    if (/larger than 250 MB/.test(String(error?.message))) throw error;
    throw new Error('The browser could not decode this audio codec locally.');
  } finally {
    context.close().catch(() => {});
  }
}

function boundedVideoSize(width, height) {
  let scale = Math.min(1, MAX_VIDEO_DIMENSION / width, MAX_VIDEO_DIMENSION / height);
  if (width * height * scale * scale > MAX_VIDEO_PIXELS) scale *= Math.sqrt(MAX_VIDEO_PIXELS / (width * height * scale * scale));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function canvasBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The browser could not encode this video frame.')), mime, quality);
  });
}

async function videoFrame(record, options) {
  if (record.size > MAX_MEDIA_SOURCE_BYTES) throw new Error('Media conversion is limited to 250 MB source files.');
  const url = URL.createObjectURL(record.blob);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  try {
    const metadata = waitForMedia(video, 'loadedmetadata', 'The browser could not decode this video codec locally.');
    video.src = url;
    video.load();
    await metadata;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const requested = Math.max(0, Number(options.timestamp) || 0);
    const timestamp = duration > 0 ? Math.min(requested, Math.max(0, duration - 0.001)) : 0;
    if (timestamp > 0.001) {
      const seeked = waitForMedia(video, 'seeked', 'The browser could not seek to that frame.');
      video.currentTime = timestamp;
      await seeked;
    } else if (video.readyState < 2) {
      await waitForMedia(video, 'loadeddata', 'The browser could not load the first video frame.');
    }
    if (!video.videoWidth || !video.videoHeight) throw new Error('This video has no decodable picture track.');
    const size = boundedVideoSize(video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('BoxIt could not create a video-frame canvas.');
    context.drawImage(video, 0, 0, size.width, size.height);
    const jpeg = options.format === 'jpeg';
    const qualityPercent = Math.max(10, Math.min(100, Number(options.mediaQuality) || 90));
    const blob = await canvasBlob(canvas, jpeg ? 'image/jpeg' : 'image/png', jpeg ? qualityPercent / 100 : undefined);
    return {
      blob,
      name: outputName(record, jpeg ? 'jpg' : 'png', { forceSuffix: true, suffix: `frame-${timestamp.toFixed(1).replace('.', '-')}` }),
      summary: `${jpeg ? 'JPEG' : 'PNG'} frame · ${size.width}×${size.height} · ${timestamp.toFixed(1)}s`
    };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

export const mediaConverter = {
  id: 'media',
  label: 'Media',
  matches(record) { return mediaKind(record) !== null; },
  targets(record) {
    return mediaKind(record) === 'audio'
      ? [{ value: 'wav', label: 'WAV', description: 'Decode the audio locally and write 16-bit PCM WAV.' }]
      : [
          { value: 'png', label: 'PNG frame', description: 'Extract one video frame at a chosen timestamp.' },
          { value: 'jpeg', label: 'JPEG frame', description: 'Extract one video frame with adjustable JPEG quality.' }
        ];
  },
  suggestedTarget(record) { return mediaKind(record) === 'audio' ? 'wav' : 'png'; },
  async inspect(record) { return inspectElement(record, mediaKind(record)); },
  async convert(record, options = {}) {
    const kind = mediaKind(record);
    if (kind === 'audio' && options.format === 'wav') return audioToWav(record, options);
    if (kind === 'video' && ['png', 'jpeg'].includes(options.format)) return videoFrame(record, options);
    throw new Error('BoxIt does not have that media conversion path yet.');
  }
};
