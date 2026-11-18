type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function isControl(target: EventTarget | null): target is Control {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function fieldName(control: Control): string {
  const label = control.labels?.[0]?.textContent?.trim();
  return label || control.getAttribute('aria-label') || '此项';
}

function message(control: Control): string {
  const name = fieldName(control);
  const validity = control.validity;
  if (validity.customError) return control.validationMessage;
  if (validity.valueMissing) return `请填写${name}`;
  if (validity.typeMismatch) return `${name}格式不正确`;
  if (validity.patternMismatch) return control.title || `${name}格式不正确`;
  if (validity.tooShort) return `${name}至少需要 ${control.getAttribute('minlength')} 个字符`;
  if (validity.tooLong) return `${name}最多允许 ${control.getAttribute('maxlength')} 个字符`;
  if (validity.rangeUnderflow) return `${name}不能小于 ${control.getAttribute('min')}`;
  if (validity.rangeOverflow) return `${name}不能大于 ${control.getAttribute('max')}`;
  if (validity.stepMismatch) return `${name}的小数位数或步长不符合要求`;
  if (validity.badInput) return `请输入有效的${name}`;
  return `${name}填写不正确`;
}

function container(control: Control): HTMLElement | null {
  return control.closest<HTMLElement>('.form-field, .manage-field, .price-field, .purchase-quantity, .attribute-form, label') || control.parentElement;
}

export function refreshFieldValidation(control: Control): void {
  if (control.type === 'checkbox' || control.type === 'file') return;
  if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
    const blank = control.required && control.type !== 'password' && control.value.length > 0 && !control.value.trim();
    const phone = control.dataset.validate === 'phone' && control.value.trim();
    const digits = phone ? control.value.replace(/\D/g, '').length : 0;
    const options = control.dataset.validate === 'enum-options' && control.value.trim() ? control.value.split('\n').map((value) => value.trim()).filter(Boolean) : [];
    const imageUrl = control.dataset.validate === 'image-url' && control.value.trim() && !/^https?:\/\//i.test(control.value.trim());
    control.setCustomValidity(blank ? `请填写${fieldName(control)}，不能只输入空格`
      : phone && (digits < 7 || digits > 15) ? '请填写有效联系电话（7–15 位数字）'
      : imageUrl ? '请输入以 http:// 或 https:// 开头的图片链接'
      : options.length > 50 ? '枚举选项最多 50 个'
      : options.some((value) => value.length > 255) ? '每个枚举选项最多 255 个字符'
      : new Set(options).size !== options.length ? '枚举选项不能重复' : '');
  }
  if (control.hasAttribute('aria-invalid')) {
    if (control.validity.valid) {
      control.removeAttribute('aria-invalid');
      control.removeAttribute('aria-description');
      container(control)?.removeAttribute('data-validation-message');
    } else {
      control.setAttribute('aria-description', message(control));
      container(control)?.setAttribute('data-validation-message', message(control));
    }
  }
}

export function installFieldValidation(): () => void {
  const invalid = (event: Event) => {
    if (!isControl(event.target)) return;
    event.preventDefault();
    const control = event.target;
    refreshFieldValidation(control);
    const firstInvalid = !control.form?.querySelector('[aria-invalid="true"]');
    control.setAttribute('aria-invalid', 'true');
    control.setAttribute('aria-description', message(control));
    container(control)?.setAttribute('data-validation-message', message(control));
    const details = control.closest('details');
    if (details && !details.open) details.open = true;
    if (control.form && firstInvalid) control.focus();
  };
  const update = (event: Event) => { if (isControl(event.target)) refreshFieldValidation(event.target); };
  document.addEventListener('invalid', invalid, true);
  document.addEventListener('input', update, true);
  document.addEventListener('change', update, true);
  return () => {
    document.removeEventListener('invalid', invalid, true);
    document.removeEventListener('input', update, true);
    document.removeEventListener('change', update, true);
  };
}
