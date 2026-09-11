import { listBoxes, createBox, deleteBox, addFiles, listFiles, getFile, deleteFile } from './db.js';

const boxesEl = document.querySelector('#boxes');
const emptyEl = document.querySelector('#empty');
const boxTemplate = document.querySelector('#box-template');
const fileTemplate = document.querySelector('#file-template');

document.querySelector('#new-box').addEventListener('click', makeBox);
document.querySelector('#empty-new-box').addEventListener('click', makeBox);

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

async function makeBox() {
  const name = prompt('Box name?');
  if (name === null) return;
  await createBox(name);
  await render();
}

async function render() {
  const boxes = await listBoxes();
  boxesEl.replaceChildren();
  emptyEl.classList.toggle('hidden', boxes.length > 0);

  for (const box of boxes) {
    const node = boxTemplate.content.firstElementChild.cloneNode(true);
    const input = node.querySelector('.file-input');
    const drop = node.querySelector('.drop-zone');
    const files = await listFiles(box.id);

    node.querySelector('.box-name').textContent = box.name;
    node.querySelector('.box-meta').textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;
    node.querySelector('.delete-box').addEventListener('click', async () => {
      if (!confirm(`Delete “${box.name}” and everything inside it?`)) return;
      await deleteBox(box.id);
      await render();
    });

    input.addEventListener('change', async () => {
      if (input.files.length) await addFiles(box.id, input.files);
      await render();
    });

    for (const event of ['dragenter', 'dragover']) {
      drop.addEventListener(event, e => { e.preventDefault(); drop.classList.add('drag'); });
    }
    for (const event of ['dragleave', 'drop']) {
      drop.addEventListener(event, e => { e.preventDefault(); drop.classList.remove('drag'); });
    }
    drop.addEventListener('drop', async e => {
      if (e.dataTransfer.files.length) await addFiles(box.id, e.dataTransfer.files);
      await render();
    });

    const list = node.querySelector('.file-list');
    for (const file of files) list.append(await fileRow(file));
    boxesEl.append(node);
  }
}

async function fileRow(record) {
  const row = fileTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector('.file-name').textContent = record.name;
  row.querySelector('.file-meta').textContent = `${formatBytes(record.size)} · ${record.type}`;

  row.querySelector('.delete-file').addEventListener('click', async () => {
    await deleteFile(record.id);
    await render();
  });

  row.querySelector('.download-file').addEventListener('click', async () => {
    const stored = await getFile(record.id);
    const url = URL.createObjectURL(stored.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = stored.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  row.querySelector('.use-file').addEventListener('click', async () => {
    const stored = await getFile(record.id);
    const bytes = [...new Uint8Array(await stored.blob.arrayBuffer())];
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'BOXIT_USE_FILE',
        file: { name: stored.name, type: stored.type, lastModified: stored.lastModified, bytes }
      });
      window.close();
    } catch {
      alert('BoxIt cannot access file inputs on this page.');
    }
  });

  return row;
}

render();
