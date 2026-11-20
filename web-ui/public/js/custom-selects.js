// Accessible, consistently styled dropdowns for the chat composer.
const controls = new WeakMap();
let openControl = null;
let typeahead = '';
let typeaheadTimer = 0;
let documentListenersBound = false;

export function enhanceComposerSelects(root = document) {
  root.querySelectorAll('#composerForm .composer-settings .select-wrap > select').forEach(enhanceSelect);
  if (documentListenersBound) return;
  documentListenersBound = true;
  document.addEventListener('pointerdown', closeWhenOutside, true);
  window.addEventListener('resize', repositionOpenMenu);
  window.addEventListener('scroll', repositionOpenMenu, true);
}

export function syncComposerSelect(select) {
  if (select) controls.get(select)?.sync();
}

function enhanceSelect(select) {
  if (controls.has(select)) return;
  const wrapper = select.closest('.select-wrap');
  if (!wrapper) return;

  const id = select.id || `composer-select-${Math.random().toString(36).slice(2)}`;
  const labelNode = wrapper.querySelector('.select-label');
  const label = labelNode?.textContent.trim() || select.getAttribute('aria-label') || 'Opções';
  if (labelNode && !labelNode.id) labelNode.id = `${id}-label`;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'composer-select-trigger';
  if (labelNode) button.setAttribute('aria-labelledby', `${labelNode.id} ${id}-value`);
  else button.setAttribute('aria-label', select.getAttribute('aria-label') || label);
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', `${id}-menu`);

  const value = document.createElement('span');
  value.className = 'composer-select-value';
  value.id = `${id}-value`;
  button.append(value);

  const menu = document.createElement('div');
  menu.id = `${id}-menu`;
  menu.className = 'composer-select-menu';
  menu.setAttribute('popover', 'manual');
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', label);
  menu.tabIndex = 0;

  select.classList.add('composer-select-source');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  wrapper.append(button, menu);

  const control = {
    select,
    wrapper,
    button,
    value,
    menu,
    activeIndex: -1,
    sync() {
      const selected = select.selectedOptions?.[0];
      const selectedLabel = selected?.textContent.trim() || 'Selecione…';
      value.textContent = selectedLabel;
      button.setAttribute('aria-valuetext', selectedLabel);
      button.title = select.title || selected?.title || selectedLabel;
      button.disabled = select.disabled || select.options.length === 0;
      if (menu.matches(':popover-open')) renderOptions(control);
    },
  };
  controls.set(select, control);
  control.sync();

  button.addEventListener('click', () => {
    if (openControl === control) closeMenu(control, false);
    else openMenu(control);
  });
  button.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      openMenu(control, event.key === 'ArrowUp' ? 'last' : 'selected');
    }
  });
  menu.addEventListener('click', (event) => {
    const option = event.target.closest('[role="option"]');
    if (!option || option.getAttribute('aria-disabled') === 'true') return;
    chooseOption(control, Number(option.dataset.index));
  });
  menu.addEventListener('pointermove', (event) => {
    const option = event.target.closest('[role="option"]');
    if (option && option.getAttribute('aria-disabled') !== 'true') setActiveOption(control, Number(option.dataset.index));
  });
  menu.addEventListener('keydown', (event) => handleMenuKeydown(control, event));
  select.addEventListener('change', control.sync);
  new MutationObserver(control.sync).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'label', 'value'] });
}

function renderOptions(control) {
  const { select, menu } = control;
  menu.replaceChildren();
  [...select.options].forEach((source, index) => {
    const option = document.createElement('div');
    option.id = `${menu.id}-option-${index}`;
    option.className = 'composer-select-option';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(index === select.selectedIndex));
    if (source.disabled) option.setAttribute('aria-disabled', 'true');
    option.dataset.index = String(index);
    if (select.id === 'accessModeSelect' && source.title) {
      const title = document.createElement('strong'); title.textContent = source.textContent.trim();
      const description = document.createElement('small'); description.textContent = source.title;
      option.append(title, description);
    } else option.textContent = source.textContent.trim();
    if (index === select.selectedIndex) option.classList.add('is-selected');
    menu.append(option);
  });
  if (control.activeIndex < 0 || !select.options[control.activeIndex] || select.options[control.activeIndex].disabled) {
    control.activeIndex = select.selectedIndex;
  }
  setActiveOption(control, control.activeIndex, false);
}

function openMenu(control, initial = 'selected') {
  if (control.button.disabled) return;
  if (openControl && openControl !== control) closeMenu(openControl, false);
  renderOptions(control);
  try {
    if (!control.menu.matches(':popover-open')) control.menu.showPopover();
  } catch {
    control.menu.classList.add('is-fallback-open');
  }
  openControl = control;
  control.wrapper.classList.add('is-open');
  control.button.setAttribute('aria-expanded', 'true');
  control.activeIndex = initial === 'last' ? lastEnabledIndex(control) : control.select.selectedIndex;
  positionMenu(control);
  setActiveOption(control, control.activeIndex);
  control.menu.focus({ preventScroll: true });
}

function closeMenu(control, restoreFocus) {
  if (!control) return;
  try {
    if (control.menu.matches(':popover-open')) control.menu.hidePopover();
  } catch { /* The fallback class covers browsers without the Popover API. */ }
  control.menu.classList.remove('is-fallback-open');
  control.wrapper.classList.remove('is-open');
  control.button.setAttribute('aria-expanded', 'false');
  control.menu.removeAttribute('aria-activedescendant');
  if (openControl === control) openControl = null;
  if (restoreFocus) control.button.focus({ preventScroll: true });
}

function positionMenu(control) {
  const { menu } = control;
  const rect = control.wrapper.getBoundingClientRect();
  const gap = 7;
  const viewportPadding = 8;
  const width = Math.min(Math.max(rect.width, 176), Math.max(120, window.innerWidth - viewportPadding * 2));
  const left = Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - width - viewportPadding));
  const below = Math.max(0, window.innerHeight - rect.bottom - gap - viewportPadding);
  const above = Math.max(0, rect.top - gap - viewportPadding);
  const naturalHeight = Math.min(Math.max(menu.scrollHeight, 96), 320);
  const openAbove = below < naturalHeight && above > below;
  const available = Math.max(96, Math.min(320, openAbove ? above : below));
  menu.style.width = `${width}px`;
  menu.style.maxHeight = `${available}px`;
  menu.style.left = `${left}px`;
  menu.style.top = openAbove ? `${Math.max(viewportPadding, rect.top - Math.min(naturalHeight, available) - gap)}px` : `${Math.min(window.innerHeight - available - viewportPadding, rect.bottom + gap)}px`;
}

function repositionOpenMenu() {
  if (openControl) positionMenu(openControl);
}

function closeWhenOutside(event) {
  if (!openControl) return;
  if (openControl.wrapper.contains(event.target) || openControl.menu.contains(event.target)) return;
  closeMenu(openControl, false);
}

function setActiveOption(control, index, scroll = true) {
  const options = [...control.menu.querySelectorAll('[role="option"]')];
  const option = options.find((item) => Number(item.dataset.index) === index && item.getAttribute('aria-disabled') !== 'true');
  options.forEach((item) => item.classList.toggle('is-active', item === option));
  if (!option) {
    control.menu.removeAttribute('aria-activedescendant');
    control.activeIndex = -1;
    return;
  }
  control.activeIndex = index;
  control.menu.setAttribute('aria-activedescendant', option.id);
  if (scroll) option.scrollIntoView({ block: 'nearest' });
}

function moveActive(control, direction) {
  const enabled = [...control.select.options].map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
  if (!enabled.length) return;
  let position = enabled.indexOf(control.activeIndex);
  position = position < 0 ? 0 : (position + direction + enabled.length) % enabled.length;
  setActiveOption(control, enabled[position]);
}

function lastEnabledIndex(control) {
  for (let index = control.select.options.length - 1; index >= 0; index -= 1) {
    if (!control.select.options[index].disabled) return index;
  }
  return -1;
}

function chooseOption(control, index) {
  const option = control.select.options[index];
  if (!option || option.disabled) return;
  control.select.selectedIndex = index;
  control.select.dispatchEvent(new Event('change', { bubbles: true }));
  closeMenu(control, true);
}

function handleMenuKeydown(control, event) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    moveActive(control, event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    setActiveOption(control, event.key === 'Home' ? firstEnabledIndex(control) : lastEnabledIndex(control));
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    chooseOption(control, control.activeIndex);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeMenu(control, true);
  } else if (event.key === 'Tab') {
    closeMenu(control, false);
  } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    typeahead += event.key.toLocaleLowerCase();
    clearTimeout(typeaheadTimer);
    typeaheadTimer = window.setTimeout(() => { typeahead = ''; }, 650);
    const options = [...control.select.options];
    const start = Math.max(0, options.findIndex((_, index) => index === control.activeIndex) + 1);
    const ordered = [...options.slice(start), ...options.slice(0, start)];
    const match = ordered.find((option) => !option.disabled && option.textContent.trim().toLocaleLowerCase().startsWith(typeahead));
    if (match) {
      event.preventDefault();
      setActiveOption(control, options.indexOf(match));
    }
  }
}

function firstEnabledIndex(control) {
  return [...control.select.options].findIndex((option) => !option.disabled);
}
