import {
  createBox,
  listBoxes,
  updateBoxLifecycle,
  deleteExpiredBoxes
} from './db.js';

const CAPTURE_BOX_KEY = 'boxitCaptureBoxId';
const boxesEl = document.querySelector('#boxes');
const statusEl = document.querySelector('#use-status');
const statusText = document.querySelector('#use-status-text');
const newBoxForm = document.querySelector('#new-box-form');
const newBoxDialog = document.querySelector('#new-box-dialog');
const boxNameInput = document.querySelector('#box-name-input');
const targetDialog = document.querySelector('#target-dialog');
const cancelTargetButton = document.querySelector('#cancel-target');

let syncing = false;
let syncQueued = false;
let pendingOneShotBoxId = null;
let editingBoxId = null;

function durationMilliseconds(amount, unit) {
  const value = Math.max(1, Number(amount) || 1);
  const factors = {
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000
  };
  return value * (factors[unit] || factors.hours);
}

function lifecycleFromControls(mode, amount, unit, deleteAfterUse) {
  if (mode === 'session') {
    return { mode: 'session', expiresAt: null, deleteAfterUse };
  }
  if (mode === 'duration') {
    return {
      mode: 'expires',
      expiresAt: Date.now() + durationMilliseconds(amount, unit),
      deleteAfterUse
    };
  }
  return { mode: 'persistent', expiresAt: null, deleteAfterUse };
}

function lifecycleLabel(box) {
  const lifecycle = box.lifecycle || {};
  const pieces = [];
  let temporary = false;

  if (lifecycle.mode === 'session') {
    pieces.push('Session');
    temporary = true;
  } else if (lifecycle.mode === 'expires' && Number(lifecycle.expiresAt) > Date.now()) {
    const remaining = Number(lifecycle.expiresAt) - Date.now();
    const minutes = Math.max(1, Math.ceil(remaining / 60000));
    if (minutes < 60) pieces.push(`${minutes}m left`);
    else if (minutes < 1440) pieces.push(`${Math.ceil(minutes / 60)}h left`);
    else pieces.push(`${Math.ceil(minutes / 1440)}d left`);
    temporary = true;
  }

  if (lifecycle.deleteAfterUse) {
    pieces.push('One-shot');
    temporary = true;
  }

  return {
    text: pieces.join(' · '),
    temporary
  };
}

function createModeOptions(select) {
  const options = [
    ['persistent', 'Keep forever'],
    ['duration', 'Delete after a duration'],
    ['session', 'Delete when browser restarts']
  ];
  select.replaceChildren(...options.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }));
}

function lifecycleControls(prefix) {
  const wrap = document.createElement('div');
  wrap.className = 'lifecycle-create';
  wrap.innerHTML = `
    <div class="lifecycle-create-heading">
      <strong>Lifetime</strong>
      <span>Choose how long this box should exist.</span>
    </div>
    <label>
      <select id="${prefix}-mode" class="lifecycle-select" aria-label="Box lifetime"></select>
    </label>
    <div id="${prefix}-duration" class="lifecycle-duration-row hidden">
      <input id="${prefix}-amount" class="lifecycle-number" type="number" min="1" max="10000" value="1" inputmode="numeric" aria-label="Duration amount">
      <select id="${prefix}-unit" class="lifecycle-unit" aria-label="Duration unit">
        <option value="minutes">Minutes</option>
        <option value="hours" selected>Hours</option>
        <option value="days">Days</option>
      </select>
    </div>
    <label class="lifecycle-toggle">
      <input id="${prefix}-one-shot" type="checkbox">
      <span class="lifecycle-toggle-copy">
        <strong>Delete after first successful Use</strong>
        <span>The entire box disappears only after BoxIt confirms a file was added to a webpage.</span>
      </span>
    </label>
  `;

  const mode = wrap.querySelector(`#${prefix}-mode`);
  const duration = wrap.querySelector(`#${prefix}-duration`);
  createModeOptions(mode);
  mode.addEventListener('change', () => {
    duration.classList.toggle('hidden', mode.value !== 'duration');
  });

  return wrap;
}

const newBoxLifecycle = lifecycleControls('new-lifecycle');
newBoxForm.querySelector('.dialog-actions').before(newBoxLifecycle);

function resetNewLifecycle() {
  const mode = document.querySelector('#new-lifecycle-mode');
  mode.value = 'persistent';
  document.querySelector('#new-lifecycle-duration').classList.add('hidden');
  document.querySelector('#new-lifecycle-amount').value = '1';
  document.querySelector('#new-lifecycle-unit').value = 'hours';
  document.querySelector('#new-lifecycle-one-shot').checked = false;
}

newBoxForm.addEventListener('reset', () => queueMicrotask(resetNewLifecycle));

newBoxForm.addEventListener('submit', async event => {
  event.preventDefault();
  event.stopImmediatePropagation();

  const name = boxNameInput.value.trim();
  if (!name) {
    boxNameInput.focus();
    return;
  }

  const lifecycle = lifecycleFromControls(
    document.querySelector('#new-lifecycle-mode').value,
    document.querySelector('#new-lifecycle-amount').value,
    document.querySelector('#new-lifecycle-unit').value,
    document.querySelector('#new-lifecycle-one-shot').checked
  );

  const box = await createBox(name, { lifecycle });
  await chrome.runtime.sendMessage({ type: 'BOXIT_LIFECYCLE_CHANGED', boxId: box.id }).catch(() => {});
  newBoxDialog.close();
  newBoxForm.reset();
  window.location.reload();
}, true);

const editDialog = document.createElement('dialog');
editDialog.id = 'lifecycle-dialog';
editDialog.className = 'dialog lifecycle-dialog';
editDialog.innerHTML = `
  <form id="lifecycle-form" class="dialog-card">
    <div class="dialog-heading">
      <p class="dialog-kicker">Box lifetime</p>
      <h2 id="lifecycle-title">Temporary box</h2>
      <p>Change when this box should clean itself up.</p>
    </div>
    <div id="lifecycle-edit-controls"></div>
    <p class="lifecycle-dialog-note">Expiry deletes the box and everything inside it. A failed Use never triggers one-shot deletion.</p>
    <div class="dialog-actions">
      <button id="cancel-lifecycle" class="button button-secondary" type="button">Cancel</button>
      <button class="button button-primary" type="submit">Save lifetime</button>
    </div>
  </form>
`;
document.body.append(editDialog);

const editControls = lifecycleControls('edit-lifecycle');
editDialog.querySelector('#lifecycle-edit-controls').append(editControls);
const editForm = editDialog.querySelector('#lifecycle-form');

function controlsForBox(box) {
  const lifecycle = box.lifecycle || {};
  const mode = document.querySelector('#edit-lifecycle-mode');
  const duration = document.querySelector('#edit-lifecycle-duration');
  const amount = document.querySelector('#edit-lifecycle-amount');
  const unit = document.querySelector('#edit-lifecycle-unit');
  const oneShot = document.querySelector('#edit-lifecycle-one-shot');

  oneShot.checked = Boolean(lifecycle.deleteAfterUse);

  if (lifecycle.mode === 'session') {
    mode.value = 'session';
  } else if (lifecycle.mode === 'expires' && Number(lifecycle.expiresAt) > Date.now()) {
    mode.value = 'duration';
    const remainingMinutes = Math.max(1, Math.ceil((Number(lifecycle.expiresAt) - Date.now()) / 60000));
    if (remainingMinutes % 1440 === 0) {
      amount.value = String(remainingMinutes / 1440);
      unit.value = 'days';
    } else if (remainingMinutes % 60 === 0) {
      amount.value = String(remainingMinutes / 60);
      unit.value = 'hours';
    } else {
      amount.value = String(remainingMinutes);
      unit.value = 'minutes';
    }
  } else {
    mode.value = 'persistent';
  }

  duration.classList.toggle('hidden', mode.value !== 'duration');
}

async function openLifecycleDialog(boxId) {
  const boxes = await listBoxes();
  const box = boxes.find(entry => entry.id === boxId);
  if (!box) return;
  editingBoxId = box.id;
  editDialog.querySelector('#lifecycle-title').textContent = box.name;
  controlsForBox(box);
  editDialog.showModal();
  requestAnimationFrame(() => document.querySelector('#edit-lifecycle-mode').focus());
}

editDialog.querySelector('#cancel-lifecycle').addEventListener('click', () => editDialog.close());
editDialog.addEventListener('click', event => {
  if (event.target === editDialog) editDialog.close();
});
editDialog.addEventListener('close', () => {
  editingBoxId = null;
});

editForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!editingBoxId) return;

  const lifecycle = lifecycleFromControls(
    document.querySelector('#edit-lifecycle-mode').value,
    document.querySelector('#edit-lifecycle-amount').value,
    document.querySelector('#edit-lifecycle-unit').value,
    document.querySelector('#edit-lifecycle-one-shot').checked
  );

  const updated = await updateBoxLifecycle(editingBoxId, lifecycle);
  if (updated) {
    await chrome.runtime.sendMessage({ type: 'BOXIT_LIFECYCLE_CHANGED', boxId: updated.id }).catch(() => {});
  }
  editDialog.close();
  await syncBoxes();
});

function queueSync() {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(async () => {
    syncQueued = false;
    await syncBoxes();
  });
}

async function syncBoxes() {
  if (syncing) return;
  syncing = true;

  try {
    const boxes = await listBoxes();
    const cards = [...boxesEl.querySelectorAll('.box-card')];

    for (let index = 0; index < Math.min(boxes.length, cards.length); index += 1) {
      const box = boxes[index];
      const card = cards[index];
      card.dataset.boxId = box.id;

      const nameLine = card.querySelector('.box-name-line');
      let tag = nameLine?.querySelector('.lifecycle-tag');
      const label = lifecycleLabel(box);

      if (label.text) {
        if (!tag && nameLine) {
          tag = document.createElement('span');
          tag.className = 'lifecycle-tag';
          const captureTag = nameLine.querySelector('.capture-default-tag');
          nameLine.insertBefore(tag, captureTag || null);
        }
        if (tag) {
          tag.textContent = label.text;
          tag.dataset.tone = label.temporary ? 'temporary' : 'normal';
        }
      } else {
        tag?.remove();
      }

      const deleteButton = card.querySelector('.delete-box');
      let actions = card.querySelector('.box-head-actions');
      if (!actions && deleteButton) {
        actions = document.createElement('div');
        actions.className = 'box-head-actions';
        deleteButton.before(actions);
        actions.append(deleteButton);
      }

      let lifetimeButton = actions?.querySelector('.lifecycle-button');
      if (!lifetimeButton && actions) {
        lifetimeButton = document.createElement('button');
        lifetimeButton.type = 'button';
        lifetimeButton.className = 'button button-ghost lifecycle-button';
        lifetimeButton.textContent = 'Lifetime';
        actions.insertBefore(lifetimeButton, deleteButton || null);
      }
      if (lifetimeButton) lifetimeButton.dataset.boxId = box.id;
    }
  } finally {
    syncing = false;
  }
}

boxesEl.addEventListener('click', async event => {
  const lifetimeButton = event.target.closest('.lifecycle-button');
  if (lifetimeButton) {
    await openLifecycleDialog(lifetimeButton.dataset.boxId);
    return;
  }

  const useButton = event.target.closest('.use-file');
  if (!useButton) return;
  const card = useButton.closest('.box-card');
  const boxId = card?.dataset.boxId;
  if (!boxId) {
    pendingOneShotBoxId = null;
    return;
  }

  const boxes = await listBoxes();
  const box = boxes.find(entry => entry.id === boxId);
  pendingOneShotBoxId = box?.lifecycle?.deleteAfterUse ? boxId : null;
}, true);

cancelTargetButton?.addEventListener('click', () => {
  pendingOneShotBoxId = null;
}, true);

targetDialog?.addEventListener('click', event => {
  if (event.target === targetDialog) pendingOneShotBoxId = null;
}, true);

async function completeOneShotIfNeeded() {
  if (!pendingOneShotBoxId) return;
  const boxId = pendingOneShotBoxId;
  pendingOneShotBoxId = null;

  const response = await chrome.runtime.sendMessage({
    type: 'BOXIT_COMPLETE_ONE_SHOT',
    boxId
  }).catch(() => null);

  if (response?.deleted) {
    statusText.textContent = `Used the file and deleted ${response.boxName}.`;
    statusEl.dataset.tone = 'success';
    statusEl.classList.remove('hidden');
    setTimeout(() => window.location.reload(), 650);
  }
}

const statusObserver = new MutationObserver(() => {
  const text = statusText.textContent || '';
  const tone = statusEl.dataset.tone;
  if (tone === 'success' && text.startsWith('Added ')) {
    completeOneShotIfNeeded();
  } else if (tone === 'error') {
    pendingOneShotBoxId = null;
  }
});
statusObserver.observe(statusEl, { attributes: true, childList: true, subtree: true });

chrome.runtime.onMessage.addListener(message => {
  if (message?.type !== 'BOXIT_BOX_REMOVED') return;
  if (message.boxId === editingBoxId) editDialog.close();
  setTimeout(() => window.location.reload(), 250);
});

const boxesObserver = new MutationObserver(queueSync);
boxesObserver.observe(boxesEl, { childList: true, subtree: true });

async function initLifecycle() {
  const expired = await deleteExpiredBoxes();
  if (expired.length) {
    const stored = await chrome.storage.local.get(CAPTURE_BOX_KEY);
    if (expired.some(box => box.id === stored[CAPTURE_BOX_KEY])) {
      await chrome.storage.local.remove(CAPTURE_BOX_KEY);
    }
    window.location.reload();
    return;
  }

  resetNewLifecycle();
  await syncBoxes();
  setInterval(syncBoxes, 30000);
}

initLifecycle();
