import { listBoxes, createBox, deleteBox, addFiles, listFiles, getFile, deleteFile } from './db.js';

const boxesEl = document.querySelector('#boxes');
const emptyEl = document.querySelector('#empty');
const boxTemplate = document.querySelector('#box-template');
const fileTemplate = document.querySelector('#file-template');
const fileEmptyTemplate = document.querySelector('#file-empty-template');
const newBoxDialog = document.querySelector('#new-box-dialog');
const newBoxForm = document.querySelector('#new-box-form');
const boxNameInput = document.querySelector('#box-name-input');
const cancelNewBoxButton = document.querySelector('#cancel-new-box');

for (const button of [document.querySelector('#new-box'), document.querySelector('#empty-new-box')]) {
  button.addEventListener('click', openNewBoxDialog);
}

cancelNewBoxButton.addEventListener('click', () => newBoxDialog.close());

newBoxDialog.addEventListener('click', event => {
  if (event.target === newBoxDialog) newBoxDialog.close();
});

newBoxForm.addEventListener('submit', async event => {
  event.preventDefault();
  const name = boxNameInput.value.trim();
  if (!name) {
    boxNameInput.focus();
    return;
  }

  await createBox(name);
  newBoxDialog.close();
  newBoxForm.reset();
  await render();
});

function openNewBoxDialog() {
  newBoxForm.reset();
  newBoxDialog.showModal();
  requestAnimationFrame(() => boxNameInput.focus());
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatFileType(type) {
  if (!type) return 'Unknown type';
  const subtype = type.split('/')[1];
  if (!subtype) return type;
  return subtype.replace('vnd.openxmlformats-officedocument.', '').toUpperCase();
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

    for (const eventName of ['dragenter', 'dragover']) {
      drop.addEventListener(eventName, event => {
        event.preventDefault();
        drop.classList.add('drag');
      });
    }

    for (const eventName of ['dragleave', 'drop']) {
      drop.addEventListener(eventName, event => {
        event.preventDefault();
        drop.classList.remove('drag');
      });
    }

    drop.addEventListener('drop', async event => {
      if (event.dataTransfer.files.length) await addFiles(box.id, event.dataTransfer.files);
      await render();
    });

    const list = node.querySelector('.file-list');
    if (files.length === 0) {
      list.append(fileEmptyTemplate.content.firstElementChild.cloneNode(true));
    } else {
      for (const file of files) list.append(await fileRow(file));
    }

    boxesEl.append(node);
  }
}

async function fileRow(record) {
  const row = fileTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector('.file-name').textContent = record.name;
  row.querySelector('.file-meta').textContent = `${formatBytes(record.size)} · ${formatFileType(record.type)}`;

  row.querySelector('.delete-file').addEventListener('click', async () => {
    await deleteFile(record.id);
    await render();
  });

  row.querySelector('.download-file').addEventListener('click', async () => {
    const stored = await getFile(record.id);
    const url = URL.createObjectURL(stored.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = stored.name;
    anchor.click();
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
        file: {
          name: stored.name,
          type: stored.type,
          lastModified: stored.lastModified,
          bytes
        }
      });
      window.close();
    } catch {
      alert('BoxIt cannot access file inputs on this page.');
    }
  });

  return row;
}

render();
