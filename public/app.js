'use strict';
/* أكلني | Eklni — Smart Nutrition Platform UI & timeline UI (vanilla JS, RTL, mobile-first). */
(function () {
  const $view = document.getElementById('view');
  const $tabs = document.getElementById('tabs');
  const $sub = document.getElementById('topbar-sub');
  const $toast = document.getElementById('toast');

  const S = { me: null, meta: null, st: null, tab: 'dashboard', wizard: null, mealDay: 'training', notif: null };

  // ---------- helpers ----------
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'value') e.value = v;
      else if (k === 'checked') e.checked = !!v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) {
      if (c == null || c === false) continue;
      e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  }
  const fmt = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : Number(x).toLocaleString('ar-EG-u-nu-latn', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
  const num = (x, d = 1) => h('span', { class: 'num' }, x == null ? '—' : Number(x).toFixed(d).replace(/\.0+$/, ''));
  const dateAr = (s) => (s ? new Date(s + 'T00:00:00Z').toLocaleDateString('ar-EG-u-nu-latn', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }) : '—');
  const append = (...kids) => $view.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  function toast(msg) { $toast.textContent = msg; $toast.classList.add('show'); setTimeout(() => $toast.classList.remove('show'), 2600); }
  function notice(kind, title, items) {
    return h('div', { class: `notice ${kind}`, role: kind === 'bad' ? 'alert' : null },
      title ? h('strong', {}, title) : null,
      items && items.length ? h('ul', {}, items.map((i) => h('li', {}, i))) : null);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (res.status === 401 && !path.startsWith('/api/auth')) { S.me = null; renderAuth('login'); throw new Error('unauthenticated'); }
    if (res.status === 402) { renderLocked(data); const e = new Error('subscription'); e.status = 402; e.data = data; throw e; }
    if (!res.ok) { const e = new Error(data?.message || 'error'); e.status = res.status; e.data = data; throw e; }
    return data;
  }

  // ---------- navigation ----------
  const ICONS = {
    dashboard: 'M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 7h6V4h-6z',
    weekly: 'M4 6h16M4 12h16M4 18h10M18 16v4M16 18h4',
    timeline: 'M3 17l6-6 4 4 8-8M15 7h6v6',
    nutrition: 'M7 3v8a3 3 0 0 0 6 0V3M10 3v18M17 3c-2 2-2 6 0 8v10',
    health: 'M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.5-7 10-7 10zM9 12h2l1-2 1 4 1-2h1',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
  };
  function renderTabs() {
    $tabs.innerHTML = '';
    for (const key of ['dashboard', 'weekly', 'timeline', 'nutrition', 'health', 'more']) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', ICONS[key]); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(p);
      $tabs.appendChild(h('button', { type: 'button', 'aria-current': S.tab === key || (key === 'more' && S.tab === 'team') ? 'page' : null, onclick: () => go(key) }, svg, t(`nav.${key}`)));
    }
    $tabs.classList.remove('hidden');
  }
  function go(tab) {
    S.tab = tab;
    if (S.st?.goal) renderTabs(); else $tabs.classList.add('hidden');
    $view.innerHTML = '';
    ({ dashboard: renderDashboard, weekly: renderWeekly, timeline: renderTimeline, nutrition: renderNutrition, health: renderHealth, more: renderMore, team: renderTeam }[tab])();
    $view.focus(); window.scrollTo(0, 0);
  }

  // ---------- auth ----------
  function renderAuth(mode) {
    $tabs.classList.add('hidden'); $sub.textContent = '';
    $view.innerHTML = '';
    const err = h('div', { class: 'field-error' });
    const email = h('input', { type: 'email', autocomplete: 'email', required: true, id: 'email' });
    const pass = h('input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true, minlength: 8, id: 'pass' });
    const form = h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      try {
        const r = await api('POST', `/api/auth/${mode}`, { email: email.value, password: pass.value });
        S.me = r.user; await boot();
      } catch (ex) {
        const d = ex.data || {};
        err.textContent = d.message || Object.values(d.errors || {})[0] || 'تعذر الاتصال بالخادم.';
      }
    } },
      h('h1', {}, mode === 'login' ? 'تسجيل الدخول' : 'حساب جديد'),
      h('p', { class: 'muted small' }, 'بياناتك (الأهداف والقياسات وسجل المتابعة) تُحفظ في حسابك فقط.'),
      h('label', { for: 'email' }, 'البريد الإلكتروني'), email,
      h('label', { for: 'pass' }, 'كلمة المرور', mode === 'register' ? h('span', { class: 'opt' }, ' (8 أحرف على الأقل)') : null), pass,
      err,
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, mode === 'login' ? 'دخول' : 'إنشاء الحساب')),
      S.meta && S.meta.googleEnabled ? h('div', { class: 'google-box' }, h('p', { class: 'center small muted' }, 'أو'),
        h('a', { class: 'btn google', href: '/api/auth/google' }, h('span', { class: 'g-mark', 'aria-hidden': 'true' }, 'G'), mode === 'login' ? 'ادخل بحساب جوجل (Gmail)' : 'اشترك بحساب جوجل (Gmail)'),
        h('p', { class: 'small muted center' }, 'بناخد من جوجل إيميلك المتأكد ورقم تعريف الحساب بس، ومش بناخد صلاحية على الإيميل أو الملفات.')) : null,
      h('p', { class: 'center small' }, h('button', { type: 'button', class: 'ghost', onclick: () => renderAuth(mode === 'login' ? 'register' : 'login') },
        mode === 'login' ? 'ليس لديك حساب؟ أنشئ حسابًا' : 'لديك حساب؟ سجّل الدخول')),
      mode === 'login' ? h('button', { type: 'button', class: 'ghost', onclick: async () => {
        if (!email.value) { err.textContent = 'اكتب إيميلك الأول.'; return; }
        try { const r = await api('POST', '/api/auth/reset-request', { email: email.value }); err.textContent = r.message; } catch (ex) { err.textContent = ex.data?.message || 'تعذر الطلب.'; }
      } }, 'نسيت كلمة المرور؟') : null);
    $view.appendChild(h('div', {}, h('div', { class: 'center pad' }, h('h1', {}, 'أكلني | Eklni'), h('p', { class: 'muted' }, 'تغذية رياضية مصرية · تخطيط خسارة الدهون للرياضيين')), form));
  }

  // one-time links: #reset=<token> (new password) and #verify=<token> (e-mail confirmation)
  async function handleLinkHash() {
    const g = /^#google=(ok|new|failed)$/.exec(location.hash);
    if (g) {
      history.replaceState(null, '', location.pathname);
      if (g[1] === 'failed') setTimeout(() => toast('تعذر الدخول بجوجل؛ جرّب تاني أو ادخل بالإيميل وكلمة المرور.'), 300);
      else if (g[1] === 'new') setTimeout(() => toast('أهلًا بيك! اتعمل حسابك بجوجل.'), 300);
      return false;
    }
    const m = /^#(reset|verify)=([A-Za-z0-9_-]{20,100})$/.exec(location.hash);
    if (!m) return false;
    history.replaceState(null, '', location.pathname);
    if (m[1] === 'verify') {
      try { await api('POST', '/api/auth/verify', { token: m[2] }); toast('اتأكد الإيميل'); } catch (ex) { toast(ex.data?.message || 'الرابط غير صالح'); }
      return false;
    }
    $tabs.classList.add('hidden'); $view.innerHTML = '';
    const pw = h('input', { type: 'password', minlength: 8, maxlength: 200, autocomplete: 'new-password', required: true });
    const msg = h('div', { class: 'field-error' });
    $view.append(h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      try { await api('POST', '/api/auth/reset', { token: m[2], password: pw.value }); toast('اتغيرت كلمة المرور'); renderAuth('login'); }
      catch (ex) { msg.textContent = ex.data?.message || 'تعذر التغيير.'; }
    } }, h('h1', {}, 'كلمة مرور جديدة'), h('label', {}, 'كلمة المرور (8 أحرف على الأقل)'), pw, msg,
      h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'primary' }, 'حفظ'))));
    return true;
  }

  // ---------- goal setup wizard ----------
  const LOSS_GOALS = ['fat_loss', 'preserve_muscle', 'performance'];
  const GAIN_GOALS = ['muscle_gain', 'weight_gain', 'fat_gain'];
  const isGainGoal = (g) => GAIN_GOALS.includes(g);
  const STEP_FIELDS = [
    ['fullName', 'sex', 'age', 'heightCm', 'currentWeight', 'bodyFatPct', 'bodyFatMethod', 'waistCm'],
    ['targetWeight', 'targetBodyFatPct', 'targetWaistCm', 'primaryGoal', 'startDate', 'targetDate'],
    ['isAthlete', 'activityLevel', 'sport', 'swimDiscipline', 'discipline', 'sessionsPerWeek', 'minutesPerSession', 'intensity', 'seasonPhase', 'competitionDate', 'measuredRmr'],
    ['hunger', 'energy', 'sleep', 'adherence', 'recentWeeklyChangeKg', 'medicalCondition', 'weightMedication', 'pregnantOrBreastfeeding'],
    ['weeklyRateKg'],
  ];
  const STEP_TITLES = ['بياناتك الحالية', 'هدفك', 'النشاط والتمرين', 'الجوع والطاقة والصحة', 'المعدل والمعاينة'];

  function startWizard(fromGoal) {
    const base = fromGoal ? { ...fromGoal } : {};
    S.wizard = {
      step: 0, errors: {}, preview: null, rateMode: 'recommended',
      data: {
        sex: 'male', activityLevel: 'light', sport: 'general', sessionsPerWeek: 3, minutesPerSession: 60, intensity: 'moderate',
        primaryGoal: 'fat_loss', seasonPhase: 'pre_season', isAthlete: true, startDate: S.meta.today, ...base, weeklyRateKg: null, targetDate: base.targetDate || null,
      },
    };
    if (fromGoal) S.wizard.data.startDate = S.meta.today;
    if (S.wizard.data.isAthlete !== false) S.wizard.data.isAthlete = true;
    if (!S.wizard.data.seasonPhase) S.wizard.data.seasonPhase = 'pre_season';
    renderWizard();
  }

  function wField(label, name, opts = {}) {
    const W = S.wizard, d = W.data;
    const id = `f-${name}`;
    let input;
    const set = (v) => { d[name] = v; delete W.errors[name]; };
    if (opts.options) {
      input = h('select', { id, onchange: (e) => { set(e.target.value || null); if (opts.onSet) opts.onSet(); if (opts.rerender) renderWizard(); } },
        opts.optional ? h('option', { value: '' }, '— غير محدد —') : null,
        opts.options.map(([v, l]) => h('option', { value: v, selected: d[name] === v ? true : null }, l)));
    } else if (opts.scale) {
      input = h('div', { class: 'scale', role: 'radiogroup', 'aria-label': label },
        [1, 2, 3, 4, 5].map((n) => h('button', { type: 'button', role: 'radio', 'aria-checked': d[name] === n ? 'true' : 'false', class: d[name] === n ? 'active' : null,
          onclick: () => { set(d[name] === n ? null : n); renderWizard(); } }, String(n))));
    } else if (opts.check) {
      return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d[name], onchange: (e) => set(e.target.checked) }), label);
    } else {
      input = h('input', { id, type: opts.type || 'number', inputmode: opts.type ? null : 'decimal', step: opts.step || 'any',
        value: d[name] ?? '', placeholder: opts.placeholder || null, oninput: (e) => set(e.target.value === '' ? null : e.target.value) });
    }
    if (W.errors[name]) input.classList.add('input-error');
    return h('div', {}, h('label', { for: id }, label, opts.optional ? h('span', { class: 'opt' }, ' (اختياري)') : null),
      opts.hint ? h('div', { class: 'muted small' }, opts.hint) : null, input,
      W.errors[name] ? h('div', { class: 'field-error' }, W.errors[name]) : null);
  }

  function renderWizard() {
    $tabs.classList.toggle('hidden', !S.st?.goal);
    $view.innerHTML = '';
    const W = S.wizard, s = W.step;
    const sports = S.meta.sports.map((x) => [x.key, x.ar]);
    const body = [
      () => [
        wField('الاسم (بيظهر في ملف التغذية والتقرير)', 'fullName', { type: 'text', optional: true, placeholder: 'مثلًا: محمد أحمد' }),
        h('div', { class: 'seg' }, ['male', 'female'].map((v) => h('button', { type: 'button', class: W.data.sex === v ? 'active' : null, onclick: () => { W.data.sex = v; renderWizard(); } }, t(`sex.${v}`)))),
        h('div', { class: 'row' }, wField('العمر (سنة)', 'age'), wField('الطول (سم)', 'heightCm')),
        wField('الوزن الحالي (كجم)', 'currentWeight', { hint: 'يُفضل متوسط وزن عدة أيام صباحًا بعد الحمام وقبل الأكل.' }),
        h('div', { class: 'row' }, wField('نسبة الدهون الحالية %', 'bodyFatPct', { optional: true }),
          wField('طريقة القياس', 'bodyFatMethod', { optional: true, options: ['dexa', 'skinfold', 'bia', 'tape', 'visual'].map((k) => [k, t(`bf.${k}`)]) })),
        wField('محيط الخصر الحالي (سم)', 'waistCm', { optional: true }),
      ],
      () => [
        wField('الوزن المستهدف (كجم)', 'targetWeight', { hint: 'لا يوجد وزن "مثالي" واحد للرياضيين، ومؤشر كتلة الجسم وحده لا يحدده.' }),
        h('div', { class: 'row' }, wField('نسبة الدهون المستهدفة %', 'targetBodyFatPct', { optional: true }), wField('محيط الخصر المستهدف (سم)', 'targetWaistCm', { optional: true })),
        wField('الهدف الأساسي', 'primaryGoal', { rerender: true, options: [...LOSS_GOALS, ...GAIN_GOALS].map((k) => [k, t(`goal.${k}`)]),
          hint: isGainGoal(W.data.primaryGoal) ? 'هدف زيادة: الوزن المستهدف لازم يبقى أعلى من وزنك الحالي.' : 'هدف خسارة: الوزن المستهدف لازم يبقى أقل من وزنك الحالي.' }),
        h('div', { class: 'row' }, wField('تاريخ البداية', 'startDate', { type: 'date' }), wField('تاريخ مستهدف تحدده أنت', 'targetDate', { type: 'date', optional: true })),
      ],
      () => [
        h('label', {}, 'انت رياضي؟'),
        h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'رياضي ولا لأ' }, [[true, 'رياضي (بتمرن رياضة معينة)'], [false, 'مش رياضي']].map(([v, l]) =>
          h('button', { type: 'button', role: 'radio', 'aria-checked': W.data.isAthlete === v ? 'true' : 'false', class: W.data.isAthlete === v ? 'active' : null,
            onclick: () => { W.data.isAthlete = v; if (!v) { W.data.sport = 'general'; W.data.discipline = null; W.data.swimDiscipline = null; W.data.competitionDate = null; } else if (!W.data.seasonPhase) W.data.seasonPhase = 'pre_season'; renderWizard(); } }, l))),
        wField(W.data.isAthlete ? 'النشاط اليومي خارج التدريب' : 'نشاطك اليومي (شغل، مشي، حركة)', 'activityLevel', { options: ['sedentary', 'light', 'active', 'very_active'].map((k) => [k, t(`act.${k}`)]),
          hint: 'التدريب يُحسب منفصلًا حتى لا يُحتسب النشاط الرياضي مرتين.' }),
        W.data.isAthlete === false ? h('p', { class: 'small muted' }, 'لو بتتمرن (جيم، مشي سريع، أي نشاط) اكتب عدد المرات والمدة؛ لو مش بتتمرن خليهم 0.') : null,
        W.data.isAthlete === false ? null : wField('نوع الرياضة', 'sport', { options: sports.filter(([k]) => k !== 'general'), rerender: true, onSet: () => { W.data.discipline = null; W.data.swimDiscipline = W.data.sport === 'swimming' || W.data.sport === 'fin_swimming' ? W.data.swimDiscipline : null; } }),
        W.data.isAthlete && (W.data.sport === 'swimming' || W.data.sport === 'fin_swimming') ? wField('التخصص', 'swimDiscipline', { optional: true, options: [['sprint', 'سرعات (50–100م)'], ['middle', 'مسافات متوسطة (200–400م)'], ['distance', 'مسافات طويلة (800–1500م)'], ['open_water', 'مياه مفتوحة'], ['mono', 'زعانف «مونو»'], ['bi_fins', 'زعانف مزدوجة (Bi-fins)'], ['apnea', 'غطس (Apnea)']] }) : null,
        W.data.isAthlete && W.data.sport === 'fencing' ? wField('السلاح', 'discipline', { optional: true, options: [['foil', 'شيش (Foil)'], ['epee', 'سيف مبارزة (Épée)'], ['sabre', 'سيبر (Sabre)']] }) : null,
        W.data.isAthlete && W.data.sport === 'triathlon' ? wField('المسافة', 'discipline', { optional: true, options: [['sprint_tri', 'سبرنت'], ['olympic', 'أولمبي'], ['half', 'نص آيرونمان (70.3)'], ['full', 'آيرونمان كامل']] }) : null,
        h('div', { class: 'row' }, wField(W.data.isAthlete ? 'عدد الحصص أسبوعيًا' : 'مرات التمرين في الأسبوع', 'sessionsPerWeek'), wField(W.data.isAthlete ? 'مدة الحصة (دقيقة)' : 'مدة التمرين (دقيقة)', 'minutesPerSession')),
        wField(W.data.isAthlete ? 'شدة التدريب' : 'شدة التمرين', 'intensity', { options: ['low', 'moderate', 'high'].map((k) => [k, t(`int.${k}`)]) }),
        W.data.isAthlete === false ? null : wField('مرحلة الموسم', 'seasonPhase', { options: [['off_season', 'خارج الموسم'], ['pre_season', 'فترة الإعداد'], ['in_season', 'فترة المنافسات'], ['transition', 'الراحة الانتقالية']],
          hint: isGainGoal(W.data.primaryGoal) ? 'المرحلة بتحدد أقصى معدل زيادة وكمية الكربوهيدرات.' : 'المرحلة بتحدد أقصى معدل خسارة آمن وكمية الكربوهيدرات.' }),
        W.data.isAthlete === false ? null : wField('موعد أقرب منافسة', 'competitionDate', { type: 'date', optional: true }),
        wField('معدل الأيض المقاس RMR (سعرة/يوم)', 'measuredRmr', { optional: true, hint: 'لو اتقاس بجهاز (Indirect calorimetry) في معمل؛ لو مش متاح سيبه فاضي ونحسبه بالمعادلة.' }),
      ],
      () => [
        h('p', { class: 'muted small' }, 'من 1 (منخفض) إلى 5 (مرتفع). اتركها فارغة إن لم تكن متأكدًا.'),
        wField('مستوى الجوع', 'hunger', { scale: true }), wField('مستوى الطاقة', 'energy', { scale: true }),
        wField('جودة النوم', 'sleep', { scale: true }), wField('القدرة على الالتزام', 'adherence', { scale: true }),
        isGainGoal(W.data.primaryGoal) ? null : wField('متوسط تغير وزنك الأسبوعي مؤخرًا (كجم، الخسارة بالموجب)', 'recentWeeklyChangeKg', { optional: true }),
        wField('لدي حالة طبية تؤثر في الوزن أو التغذية', 'medicalCondition', { check: true }),
        wField('أتناول أدوية تؤثر في الوزن أو الشهية', 'weightMedication', { check: true }),
        W.data.sex === 'female' ? wField('حامل أو مرضعة', 'pregnantOrBreastfeeding', { check: true }) : null,
      ],
      () => previewStep(),
    ][s]();

    const isLast = s === STEP_FIELDS.length - 1;
    $view.appendChild(h('div', {},
      h('h1', {}, isGainGoal(W.data.primaryGoal) ? 'هدفي في زيادة الوزن' : t('goal.title')),
      h('div', { class: 'steps', 'aria-hidden': 'true' }, STEP_FIELDS.map((_, i) => h('span', { class: i <= s ? 'on' : null }))),
      !S.st?.goal && s === 0 ? h('div', { class: 'notice info' }, h('strong', {}, 'مدرب أو أخصائي أو ولي أمر، أو معاك كود من أكاديمية؟'),
        h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => go('team') }, 'الأكاديمية والفريق'))) : null,
      h('div', { class: 'card' }, h('h2', {}, `${s + 1}. ${STEP_TITLES[s]}`), body,
        h('div', { class: 'actions' },
          s > 0 ? h('button', { type: 'button', onclick: () => { W.step--; renderWizard(); } }, 'السابق') :
            (S.st?.goal ? h('button', { type: 'button', onclick: () => { S.wizard = null; go('dashboard'); } }, 'إلغاء') : null),
          isLast ? h('button', { type: 'button', class: 'primary', disabled: !W.preview || null, onclick: saveGoal }, 'حفظ الخطة') :
            h('button', { type: 'button', class: 'primary', onclick: next }, s === STEP_FIELDS.length - 2 ? 'احسب الخطة' : 'التالي')))));
  }

  async function next() {
    const W = S.wizard;
    W.step++;
    if (W.step === STEP_FIELDS.length - 1) { await runPreview(); return; }
    renderWizard();
  }

  function payload() {
    const d = { ...S.wizard.data };
    if (S.wizard.rateMode !== 'custom') d.weeklyRateKg = null;
    return d;
  }

  async function runPreview() {
    const W = S.wizard;
    W.preview = null; W.errors = {}; W.previewError = null;
    renderWizard();
    try {
      W.preview = await api('POST', '/api/goal/preview', payload());
    } catch (e) {
      const errs = e.data?.errors || {};
      W.errors = errs;
      const firstStep = STEP_FIELDS.findIndex((fs) => fs.some((f) => errs[f]));
      if (firstStep >= 0 && firstStep < STEP_FIELDS.length - 1) { W.step = firstStep; }
      else W.previewError = Object.values(errs)[0] || 'تعذر حساب الخطة.';
    }
    renderWizard();
  }

  function previewStep() {
    const W = S.wizard, P = W.preview;
    if (W.previewError) return [notice('bad', W.previewError)];
    if (!P) return [h('p', { class: 'muted' }, 'جارٍ الحساب…')];
    const p = P.plan, r = p.recommendation, tl = p.timeline, n = p.nutrition;
    const gain = p.direction === 'gain';
    const customInput = h('input', { type: 'number', step: '0.01', inputmode: 'decimal', value: W.data.weeklyRateKg ?? r.recommendedKg,
      oninput: (e) => { W.data.weeklyRateKg = e.target.value === '' ? null : Number(e.target.value); } });
    return [
      h('div', { class: 'card flat' },
        h('h3', {}, 'المعدل الأسبوعي'),
        h('p', {}, 'المعدل الموصى به لحالتك: ', h('strong', {}, num(r.recommendedKg, 2), ' كجم/أسبوع'), ` (${fmt(r.recommendedPct, 2)}% من الوزن)`),
        h('p', { class: 'small muted' }, 'النطاق المسموح لحالتك: ', num(r.allowedRangeKg[0], 2), ' – ', num(r.allowedRangeKg[1], 2), ' كجم/أسبوع'),
        r.reasons.length ? h('ul', { class: 'small' }, r.reasons.map((x) => h('li', {}, x))) : null,
        h('p', { class: 'small muted' }, r.note),
        h('div', { class: 'seg' },
          h('button', { type: 'button', class: W.rateMode === 'recommended' ? 'active' : null, onclick: () => { W.rateMode = 'recommended'; runPreview(); } }, 'الموصى به'),
          h('button', { type: 'button', class: W.rateMode === 'custom' ? 'active' : null, onclick: () => { W.rateMode = 'custom'; W.data.weeklyRateKg ??= r.recommendedKg; renderWizard(); } }, 'معدل مخصص')),
        W.rateMode === 'custom' ? h('div', {}, h('label', {}, 'المعدل المخصص (كجم/أسبوع)'), customInput,
          W.errors.weeklyRateKg ? h('div', { class: 'field-error' }, W.errors.weeklyRateKg) : null,
          h('div', { class: 'actions' }, h('button', { type: 'button', onclick: runPreview }, 'أعد الحساب'))) : null),
      p.requiresProfessional ? notice('bad', 'هذه الخطة تحتاج مراجعة أخصائي تغذية رياضية أو طبيب قبل التطبيق.') : null,
      (P.inputWarnings.length || p.warnings.length) ? notice('warn', 'تنبيهات', [...P.inputWarnings, ...p.warnings]) : null,
      h('h3', {}, 'الجدول الزمني التقديري'),
      h('div', { class: 'kpis' },
        kpi(gain ? 'المطلوب زيادته' : 'المطلوب خسارته', num(gain ? tl.weightToGain : tl.weightToLose, 1), 'كجم'),
        kpi('المدة', num(tl.estimatedWeeks, 1), 'أسبوع', `≈ ${tl.calendarMonths} شهر و${tl.remainderDays} يوم`),
        kpi('الموعد التقريبي', dateAr(tl.completionDate), '', `بمعدل ${p.effectiveRateKg} كجم/أسبوع`)),
      h('p', { class: 'small muted' }, tl.note),
      p.targetDateCheck ? targetDateBlock(p.targetDateCheck) : null,
      h('h3', {}, 'الطاقة والماكروز المبدئية'),
      nutritionTable(n.trainingDay, n.restDay),
      h('p', { class: 'small muted' }, `${energyLine(n)} · ${gain ? `الفائض ${fmt(n.dailySurplus, 0)} سعرة/يوم (${fmt(n.surplusPctOfTdee)}%)` : `العجز ${fmt(n.dailyDeficit, 0)} سعرة/يوم (${fmt(n.deficitPctOfTdee)}%)`} · ${n.note}`),
    ];
  }

  function targetDateBlock(c) {
    if (c.feasible) return notice('good', `تاريخك المستهدف ممكن بمعدل ${c.requiredRateKg} كجم/أسبوع ضمن النطاق الآمن.`);
    return h('div', { class: 'notice warn' }, h('strong', {}, 'التاريخ المستهدف غير واقعي بأمان'), h('p', {}, c.message),
      c.alternatives ? h('ul', {}, c.alternatives.map((a) => h('li', {}, `${a.label} (${a.rateKg} كجم/أسبوع): ${dateAr(a.completionDate)}`))) : null,
      c.interimTargetWeight ? h('p', {}, `هدف مرحلي واقعي حتى تاريخك: نحو ${c.interimTargetWeight} كجم.`) : null);
  }

  async function saveGoal() {
    try {
      S.st = await api('POST', '/api/goal', payload());
      S.wizard = null; toast('تم حفظ الخطة'); go('dashboard');
    } catch (e) {
      S.wizard.errors = e.data?.errors || {}; S.wizard.previewError = Object.values(S.wizard.errors)[0] || 'تعذر الحفظ.'; renderWizard();
    }
  }

  // ---------- shared blocks ----------
  function kpi(label, value, unit, hint) {
    return h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value, unit ? h('small', {}, ' ', unit) : null), hint ? h('div', { class: 'hint' }, hint) : null);
  }
  function nutritionTable(tr, rest) {
    const row = (d, l) => d && h('tr', {}, h('th', {}, l), ...[d.kcal, d.proteinG, d.carbG, d.fatG, d.fiberG].map((v) => h('td', { class: 'n' }, String(v))));
    return h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, ''), ...['سعرات', 'بروتين جم', 'كارب جم', 'دهون جم', 'ألياف جم'].map((x) => h('th', { class: 'n' }, x)))),
      h('tbody', {}, row(tr, 'يوم تدريب'), row(rest, 'يوم راحة'))),
      // macro detail (audit 2026-10-22, F5): g/kg, % of energy and the 4/4/9 check against the calorie target
      [[tr, 'يوم تدريب'], [rest, 'يوم راحة']].filter(([d]) => d && d.macroKcal != null).map(([d, l]) => h('p', { class: 'small muted' },
        `${l}: بروتين ${d.proteinGPerKg} جم/كجم (${d.proteinPctKcal}%) · كارب ${d.carbGPerKg} جم/كجم (${d.carbPctKcal}%) · دهون ${d.fatGPerKg} جم/كجم (${d.fatPctKcal}%) · طاقة الماكروز (4/4/9) ${d.macroKcal} سعرة${d.macroGapKcal ? `، الفرق عن الهدف ${d.macroGapKcal > 0 ? '+' : ''}${d.macroGapKcal} من تقريب الجرامات` : ''}.`)));
  }
  function energyLine(n) {
    const r = n.needs.tdeeRange;
    return `معدل الأيض أثناء الراحة ${n.needs.bmrKey === 'measured' ? 'المقاس' : 'المتوقع (معادلة، مش قياس)'} ${fmt(n.needs.bmr, 0)} سعرة (${n.needs.bmrEquation}) · الاحتياج اليومي المقدّر ${fmt(n.needs.tdeeAvg, 0)} سعرة${r ? ` (سيناريو ${fmt(r.low, 0)}–${fmt(r.high, 0)})` : ''}`;
  }
  function currentWeek() { return Math.max(0, Math.floor((Date.parse(S.meta.today) - Date.parse(S.st.goal.startDate)) / (7 * 86400000))); }

  // ---------- dashboard ----------
  function renderDashboard() {
    const st = S.st, g = st.goal, tl = st.timeline, ev = st.evaluation;
    const lastRow = [...st.rows].reverse().find((r) => r.avgWeight != null);
    const progress = lastRow ? lastRow.goalProgressPct : 0;
    const bar = h('span', {}); bar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    const quickW = h('input', { type: 'number', step: '0.1', inputmode: 'decimal', placeholder: 'وزن اليوم (كجم)', 'aria-label': 'وزن اليوم بالكيلوجرام' });
    append(
      h('h1', {}, isGainGoal(g.input && g.input.primaryGoal) ? 'هدفي في زيادة الوزن' : t('goal.title')),
      S.sub && S.sub.daysLeft != null && S.sub.daysLeft <= 5 ? notice('warn', `${S.sub.state === 'trial' ? 'الفترة التجريبية' : 'اشتراكك'} بيخلص بعد ${S.sub.daysLeft} ${S.sub.daysLeft === 1 ? 'يوم' : 'أيام'} (${dateAr(S.sub.endsOn)}). بعدها الأدوات بتتقفل لحد التجديد.`) : null,
      holdBanner(st.hold),
      waiverNotice(st.hold),
      inboxCard(),
      st.plan.requiresProfessional ? notice('bad', 'هذه الخطة تحتاج مراجعة أخصائي تغذية رياضية أو طبيب.') : null,
      st.planReview && st.planReview.state !== 'none' ? notice(st.planReview.state === 'current' && st.planReview.decision === 'approved' ? 'good' : 'warn', st.planReview.text, st.planReview.note ? [`ملاحظة الأخصائي: ${st.planReview.note}`] : undefined) : null,
      h('div', { class: 'kpis' },
        kpi('الوزن الابتدائي', num(g.startWeight), 'كجم'),
        kpi('متوسط الوزن الحالي', num(tl.currentWeight, 2), 'كجم', lastRow ? `الأسبوع ${lastRow.week + 1}` : 'لا قياسات بعد'),
        kpi('الوزن المستهدف', num(g.targetWeight), 'كجم'),
        kpi('المعدل المخطط', num(g.weeklyRateKg, 2), 'كجم/أسبوع'),
        kpi('الموعد المتوقع', dateAr(tl.projection.completionDate), '', 'تقدير وليس وعدًا'),
        kpi('تحقيق الهدف', num(progress, 0), '%')),
      h('div', { class: 'card' }, h('div', { class: 'spread' }, h('strong', {}, 'التقدم نحو الهدف'), h('span', { class: 'muted small' }, `${fmt(progress, 0)}%`)),
        h('div', { class: 'bar' }, bar), h('p', { class: 'small muted' }, tl.projection.reason),
        tl.projection.changeText ? notice('info', tl.projection.changeText) : null),
      h('form', { class: 'card', onsubmit: async (e) => {
        e.preventDefault();
        try { S.st = await api('POST', '/api/weights', { date: S.meta.today, weightKg: quickW.value }); toast('تم تسجيل الوزن'); go('dashboard'); }
        catch (ex) { toast(Object.values(ex.data?.errors || {})[0] || 'تعذر الحفظ'); }
      } }, h('h2', {}, 'وزن اليوم'), h('p', { class: 'small muted' }, 'سجّل وزنك عدة مرات أسبوعيًا في ظروف متشابهة؛ نعتمد على المتوسط الأسبوعي لا على قراءة يوم واحد.'),
        h('div', { class: 'row' }, quickW, h('button', { class: 'primary', type: 'submit' }, 'تسجيل'))),
      h('div', { class: 'card' }, h('div', { class: 'spread' }, h('h2', {}, 'تقييم هذا الأسبوع'), h('span', { class: 'badge' }, t(`action.${ev.action}`))),
        h('ul', {}, ev.reasons.map((r) => h('li', {}, r))),
        ev.trend ? h('p', { class: 'small muted' }, `الاتجاه على ${ev.trend.weeksUsed} أسابيع: `, num(ev.observedLossKg, 2), ' كجم/أسبوع مقابل ', num(ev.targetRateKg, 2), ' مخطط') : null,
        st.pending ? notice('warn', 'يوجد اقتراح تعديل بانتظار قرارك في صفحة التغذية.') : null,
        h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => go('nutrition') }, 'التغذية والتعديلات'), h('button', { type: 'button', onclick: () => go('weekly') }, 'المتابعة الأسبوعية'))),
      st.recalcSuggested ? h('div', { class: 'notice info' }, h('strong', {}, 'تغير وزنك بوضوح منذ حساب الاحتياجات.'),
        h('p', {}, 'يُنصح بإعادة حساب الاحتياجات على متوسط وزنك الحالي.'),
        h('button', { type: 'button', class: 'primary', onclick: recalc }, 'أعد حساب الاحتياجات')) : null,
    );
  }
  async function recalc() {
    try { S.st = await api('POST', '/api/goal/recalculate'); toast('أعيد حساب الاحتياجات'); go('nutrition'); }
    catch (e) { toast('تعذر إعادة الحساب'); }
  }

  // ---------- weekly ----------
  function renderWeekly() {
    const st = S.st;
    const wDate = h('input', { type: 'date', value: S.meta.today, max: S.meta.today, min: st.goal.startDate, 'aria-label': 'التاريخ' });
    const wVal = h('input', { type: 'number', step: '0.1', inputmode: 'decimal', placeholder: 'الوزن (كجم)', 'aria-label': 'الوزن بالكيلوجرام' });
    const wk = currentWeek();
    const existing = st.rows.find((r) => r.week === wk) || {};
    const c = {
      week: wk, waistCm: existing.waistCm, bodyFatPct: existing.bodyFatPct, bodyFatMethod: existing.bodyFatMethod, caloriesAvg: existing.caloriesAvg,
      adherencePct: existing.adherencePct, performance: existing.performance, hunger: existing.hunger, energy: existing.energy,
      sleep: existing.sleep, recovery: existing.recovery, checklistConfirmed: existing.checklistConfirmed, notes: existing.notes,
    };
    const numIn = (k, label, opt) => h('div', {}, h('label', {}, label, opt ? h('span', { class: 'opt' }, ' (اختياري)') : null),
      h('input', { type: 'number', step: 'any', inputmode: 'decimal', value: c[k] ?? '', oninput: (e) => { c[k] = e.target.value === '' ? null : Number(e.target.value); } }));
    const scaleIn = (k, label) => {
      const wrap = h('div', {});
      const draw = () => { wrap.innerHTML = ''; wrap.append(h('label', {}, label), h('div', { class: 'scale', role: 'radiogroup', 'aria-label': label },
        [1, 2, 3, 4, 5].map((n) => h('button', { type: 'button', role: 'radio', 'aria-checked': c[k] === n ? 'true' : 'false', class: c[k] === n ? 'active' : null, onclick: () => { c[k] = c[k] === n ? null : n; draw(); } }, String(n))))); };
      draw(); return wrap;
    };
    const recent = [...st.weights].reverse().slice(0, 10);
    append(
      h('h1', {}, 'المتابعة الأسبوعية'),
      h('form', { class: 'card', onsubmit: async (e) => {
        e.preventDefault();
        try { S.st = await api('POST', '/api/weights', { date: wDate.value, weightKg: wVal.value }); toast('تم الحفظ'); go('weekly'); }
        catch (ex) { toast(Object.values(ex.data?.errors || {})[0] || 'تعذر الحفظ'); }
      } }, h('h2', {}, 'تسجيل وزن'),
        h('p', { class: 'small muted' }, 'صباحًا، بعد دخول الحمام، قبل الأكل والشرب، وبنفس الملابس تقريبًا.'),
        h('div', { class: 'row' }, wDate, wVal), h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'حفظ الوزن')),
        recent.length ? h('details', {}, h('summary', {}, `آخر القياسات (${st.weights.length})`),
          recent.map((w) => h('div', { class: 'list-item' }, h('span', {}, dateAr(w.date)), h('span', {}, num(w.weightKg), ' كجم'),
            h('button', { type: 'button', class: 'ghost danger', 'aria-label': `حذف قياس ${w.date}`, onclick: async () => { S.st = await api('DELETE', `/api/weights/${w.date}`); go('weekly'); } }, 'حذف')))) : null),
      h('form', { class: 'card', onsubmit: async (e) => {
        e.preventDefault();
        try { S.st = await api('POST', '/api/checkins', c); toast('تم حفظ المتابعة'); go('weekly'); }
        catch (ex) { toast(Object.values(ex.data?.errors || {})[0] || 'تعذر الحفظ'); }
      } }, h('h2', {}, `مراجعة الأسبوع ${wk + 1}`),
        h('div', { class: 'row' }, numIn('waistCm', 'محيط الخصر (سم)', true), numIn('caloriesAvg', 'متوسط السعرات المتناولة', true)),
        h('div', { class: 'row' }, numIn('bodyFatPct', 'نسبة الدهون %', true),
          h('div', {}, h('label', {}, 'طريقة قياس الدهون'), h('select', { onchange: (e) => { c.bodyFatMethod = e.target.value || null; } },
            h('option', { value: '' }, '—'), ['dexa', 'skinfold', 'bia', 'tape', 'visual'].map((k) => h('option', { value: k, selected: c.bodyFatMethod === k || null }, t(`bf.${k}`)))))),
        h('p', { class: 'small muted' }, 'قارن نسبة الدهون فقط عند القياس بنفس الطريقة وفي ظروف متشابهة.'),
        numIn('adherencePct', 'نسبة الالتزام بالخطة %', true),
        scaleIn('performance', 'أداء التدريب (1 ضعيف – 5 ممتاز)'), scaleIn('hunger', 'الجوع (1 منخفض – 5 مرتفع)'), scaleIn('energy', 'الطاقة (1 منخفضة – 5 مرتفعة)'),
        scaleIn('sleep', 'جودة النوم'), scaleIn('recovery', 'التعافي'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.checklistConfirmed, onchange: (e) => { c.checklistConfirmed = e.target.checked; } }),
          'راجعت دقة تسجيل الطعام والزيت، والنشاط، وأسباب احتباس السوائل هذا الأسبوع'),
        h('label', {}, 'ملاحظات', h('span', { class: 'opt' }, ' (اختياري)')), h('textarea', { rows: 2, maxlength: 500, oninput: (e) => { c.notes = e.target.value; } }, c.notes || ''),
        h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'حفظ المراجعة'))),
      progressTable(st.rows),
    );
  }

  function progressTable(rows) {
    if (!rows.length) return h('div', { class: 'card muted' }, 'لا توجد بيانات أسبوعية بعد.');
    return h('div', { class: 'card' }, h('h2', {}, 'سجل الأسابيع'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ...['أسبوع', 'المتوسط', 'قياسات', 'تغير أسبوعي', 'منذ البداية', 'الهدف %', 'الخصر', 'التزام'].map((x, i) => h('th', { class: i ? 'n' : null }, x)))),
        h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, String(r.week + 1)),
          ...[r.avgWeight, r.weighIns, r.changeVsPrev, r.changeSinceStart, r.goalProgressPct, r.waistCm, r.adherencePct].map((v) => h('td', { class: 'n' }, v == null ? '—' : String(v)))))))),
      rows.flatMap((r) => r.interpretation.map((x) => `الأسبوع ${r.week + 1}: ${x}`)).slice(-3).map((x) => h('p', { class: 'small muted' }, x)),
      h('p', { class: 'small muted' }, 'تغير الوزن يشمل الماء والجليكوجين ومحتوى الجهاز الهضمي؛ لا يمكن معرفة الدهون المفقودة بدقة من الميزان وحده.'));
  }

  // ---------- timeline ----------
  function renderTimeline() {
    const st = S.st, tl = st.timeline;
    const chartBox = h('div', { class: 'chart-wrap' });
    append(
      h('h1', {}, 'الخط الزمني للهدف'),
      h('div', { class: 'kpis' }, kpi('البداية', num(tl.startWeight), 'كجم'), kpi('الحالي', num(tl.currentWeight, 2), 'كجم'), kpi('الهدف', num(tl.targetWeight), 'كجم')),
      h('div', { class: 'card' },
        h('div', { class: 'legend' },
          h('span', {}, h('i', { class: 'lg-actual' }), 'متوسط الوزن الفعلي'), h('span', {}, h('i', { class: 'lg-plan dash' }), 'المخطط (متوسط)'),
          h('span', {}, h('i', { class: 'lg-cons dash' }), 'محافظ'), h('span', {}, h('i', { class: 'lg-slow dash' }), 'الأبطأ'), h('span', {}, h('i', { class: 'lg-target dash' }), 'الوزن المستهدف')),
        chartBox,
        h('p', { class: 'small muted' }, `العلامة الزرقاء على خط الهدف = الموعد المتوقع حاليًا (${dateAr(tl.projection.completionDate)}). ${tl.projection.reason}`),
        tl.projection.changeText ? notice('info', tl.projection.changeText) : null),
      h('div', { class: 'card' }, h('h2', {}, 'السيناريوهات'),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'السيناريو'), h('th', { class: 'n' }, 'كجم/أسبوع'), h('th', { class: 'n' }, 'أسابيع'), h('th', {}, 'التاريخ التقريبي'))),
          h('tbody', {}, tl.scenarios.map((s) => h('tr', {}, h('td', {}, s.ar, h('div', { class: 'small muted' }, s.desc)), h('td', { class: 'n' }, String(s.rateKg)), h('td', { class: 'n' }, String(s.weeks)), h('td', {}, dateAr(s.completionDate))))))),
        h('p', { class: 'small muted' }, tl.disclaimer)),
      h('details', { class: 'card' }, h('summary', {}, 'عرض البيانات كجدول'),
        h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'الأسبوع'), h('th', {}, 'التاريخ'), h('th', { class: 'n' }, 'المخطط'), h('th', { class: 'n' }, 'الفعلي'))),
          h('tbody', {}, tl.planned.map((p) => { const a = tl.actual.find((x) => x.week === p.week); return h('tr', {}, h('td', {}, String(p.week + 1)), h('td', {}, p.date), h('td', { class: 'n' }, String(p.weight)), h('td', { class: 'n' }, a ? String(a.weight) : '—')); }))))),
    );
    window.TimelineChart.render(chartBox, tl, st.goal);
  }

  // ---------- nutrition & adjustments ----------
  function renderNutrition() {
    const sub = S.nutSub || 'week';
    append(
      h('h1', {}, 'التغذية'),
      h('div', { class: 'subtabs', role: 'tablist', 'aria-label': 'أقسام التغذية' },
        [['week', 'خطة الأسبوع'], ['prefs', 'تفضيلاتي'], ['comp', 'البطولة'], ['targets', 'الأهداف'], ['recipes', 'الوصفات']].filter(([k]) => !(k === 'comp' && S.st.goal.input.isAthlete === false)).map(([k, l]) =>
          h('button', { type: 'button', role: 'tab', 'aria-selected': sub === k ? 'true' : 'false', class: sub === k ? 'active' : null,
            onclick: () => { S.nutSub = k; go('nutrition'); } }, l))));
    if (sub === 'targets') append(overrideCard(), targetsCard(), adjustmentCard(S.st));
    else if (sub === 'recipes') append(recipesCard());
    else if (sub === 'prefs') append(prefsCard());
    else if (sub === 'comp') append(competitionCard());
    else append(weekCard());
    const st = document.querySelector('.subtabs button.active');
    if (st) { const c = st.parentElement; c.scrollLeft += st.getBoundingClientRect().left - c.getBoundingClientRect().left - (c.clientWidth - st.offsetWidth) / 2; }
  }

  function targetsCard() {
    const st = S.st, n = st.plan.nutrition, tg = st.targets;
    return h('div', { class: 'card' }, h('h2', {}, 'الأهداف اليومية الحالية'),
      nutritionTable(tg.trainingDay, tg.restDay),
      h('p', { class: 'small muted' }, `${energyLine(n)}. إصدار الحسابات: ${st.calcVersion || 'قبل ترقيم الإصدارات'}.`),
      h('p', { class: 'small muted' }, `أيام التدريب ${n.trainingDays} أسبوعيًا · ${n.direction === 'gain' ? 'الفائض نفسه في أيام التدريب والراحة' : 'العجز أقل في أيام التدريب وأكبر قليلًا في أيام الراحة بنفس المجموع الأسبوعي'}. التعديلات المقبولة: ${tg.adjustmentKcal >= 0 ? '+' : ''}${tg.adjustmentKcal} سعرة/يوم (تُطبق على الكربوهيدرات).`),
      h('p', { class: 'small muted' }, `البروتين ${n.proteinPerKg} جم/كجم (≈ ${n.proteinPerMealG} جم في كل وجبة من ${n.mealsPerDay}) · توافر الطاقة ${n.energyAvailability} سعرة/كجم كتلة خالية من الدهون${n.energyAvailabilityStatus ? ` — ${n.energyAvailabilityStatus.ar}` : ''}.`),
      h('p', { class: 'small muted' }, 'في خطة الأسبوع، أهداف كل يوم بتتظبط حسب الحصص المسجلة فيه ومدتها.'),
      h('details', {}, h('summary', {}, 'إرشادات الرياضة والموسم والحفاظ على العضلات'), h('ul', { class: 'small' }, n.athleteGuidance.map((x) => h('li', {}, x)))));
  }

  // ---------- weekly plan ----------
  async function loadWeek(force) {
    if (!S.wp || force) S.wp = await api('GET', '/api/weekplan');
    if (!S.recipes) S.recipes = await api('GET', '/api/recipes');
    await loadIntake();
    return S.wp;
  }
  // logged intake (audit 2026-10-22): kept apart from the plan and the targets
  async function loadIntake() { try { S.intake = S.wp && S.wp.plan ? await api('GET', '/api/intake') : null; } catch { S.intake = null; } }
  const intakeDay = (date) => (S.intake && S.intake.days ? S.intake.days.find((d) => d.date === date) : null);
  async function logMeal(box, date, key, body, msg) {
    try { S.intake = await api('PUT', '/api/intake', { date, key, ...body }); drawWeek(box); toast(msg); }
    catch (e) { toast(e.data?.message || 'تعذر التسجيل'); }
  }
  function logRow(day, key, box, free) {
    if (!S.intake || day.date > S.meta.today) return null;
    const d = intakeDay(day.date);
    const entry = d && d.entries.find((e) => e.key === key);
    const log = entry && entry.log;
    const part = h('select', { 'aria-label': 'الجزء اللي اتاكل', onchange: (e) => logMeal(box, day.date, key, { status: 'partial', fraction: Number(e.target.value) }, 'اتسجل') },
      h('option', { value: '' }, 'أكلت جزء…'), [0.25, 0.5, 0.75].map((f) => h('option', { value: f, selected: log && log.status === 'partial' && log.fraction === f ? true : null }, `${Math.round(f * 100)}%`)));
    const btn = (st, label) => h('button', { type: 'button', class: 'small-btn' + (log && log.status === st ? ' active' : ''), 'aria-pressed': log && log.status === st ? 'true' : 'false',
      onclick: () => logMeal(box, day.date, key, { status: st }, 'اتسجل') }, label);
    return h('div', { class: 'logrow' }, h('span', { class: 'small muted' }, 'سجّل:'), btn('eaten', 'أكلتها'), free ? null : part, btn('skipped', 'ما أكلتهاش'),
      log ? h('button', { type: 'button', class: 'ghost small-btn', onclick: () => logMeal(box, day.date, key, { clear: true }, 'اتشال التسجيل') }, 'امسح') : null,
      log && log.totals ? h('span', { class: 'small' }, `المسجّل: ${macroLine(log.totals)}`) : log && free && log.status === 'eaten' ? h('span', { class: 'small muted' }, 'اتسجلت من غير قيم محسوبة') : null);
  }
  function intakeCompare(day) {
    const d = intakeDay(day.date);
    if (!d) return null;
    const row = (label, t, cls) => h('tr', cls ? { class: cls } : {}, h('td', {}, label), ...(t ? [t.kcal, t.protein, t.carb, t.fat].map((v) => h('td', { class: 'n' }, String(Math.round(v)))) : [h('td', { colspan: 4, class: 'muted' }, 'مفيش تسجيل')]));
    return h('details', { class: 'intake', open: d.status !== 'none' ? true : null },
      h('summary', {}, `الهدف والمخطط والمسجّل · ${d.statusAr}`),
      h('table', { class: 'mini' }, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'سعرات'), h('th', {}, 'بروتين'), h('th', {}, 'كارب'), h('th', {}, 'دهون'))),
        h('tbody', {}, row('الهدف', d.target), row('المخطط (أكل الخطة)', d.planned), row('المسجّل (اللي اتاكل)', d.logged, 'total'))),
      d.unlogged.length && d.status !== 'none' ? h('p', { class: 'small muted' }, `لسه ما اتسجلش: ${d.unlogged.join('، ')}.`) : null,
      d.note ? h('p', { class: 'small muted' }, d.note) : null);
  }
  function weekCard() {
    const box = h('div', {}, h('p', { class: 'muted' }, 'جارٍ تحميل خطة الأسبوع…'));
    loadWeek(true).then(() => drawWeek(box)).catch(() => { box.textContent = 'تعذر تحميل الخطة.'; });
    return box;
  }
  async function newPlan(box) {
    box.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try { S.wp = await api('POST', '/api/weekplan'); S.wpDay = 0; await loadIntake(); toast('اتعملت خطة جديدة'); drawWeek(box); }
    catch { toast('تعذر عمل الخطة'); drawWeek(box); }
  }
  function drawWeek(box) {
    const W = S.wp;
    box.innerHTML = '';
    const add = (...k) => box.append(...k.flat(Infinity).filter(Boolean));
    if (!W.plan) {
      add(h('div', { class: 'card' }, h('h2', {}, 'خطة تغذية لأسبوع كامل'),
        h('p', {}, 'الخطة بتتعمل من أهدافك اليومية وجدول تمرينك ومواعيد يومك والأكل اللي بتحبه. كل وجبة ليها ميعاد، وكميتها محسوبة على البروتين والكربوهيدرات المطلوبين.'),
        W.hasSavedPrefs ? null : h('p', { class: 'small muted' }, 'الأفضل تحدد مواعيد تمرينك وصحيانك ونومك في «تفضيلاتي» الأول، عشان مواعيد الوجبات تبقى مظبوطة.'),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'primary', onclick: () => newPlan(box) }, 'اعمل خطة الأسبوع'),
          h('button', { type: 'button', onclick: () => { S.nutSub = 'prefs'; go('nutrition'); } }, 'حدد تفضيلاتي'))));
      return;
    }
    const P = W.plan;
    const di = Math.min(S.wpDay || 0, P.days.length - 1);
    const day = P.days[di];
    const health = P.prefs.health && (P.prefs.health.lowIron || P.prefs.health.lowVitD);
    add(
      S.st.calorieOverride && S.st.calorieOverride.active ? notice('info', `سعرات مخصوصة: ${S.st.calorieOverride.kcal} سعرة/يوم لحد ${dateAr(S.st.calorieOverride.endsOn)}، وبعدها بترجع أهدافك العادية.`) : null,
      W.stale ? h('div', { class: 'notice warn' }, h('strong', {}, W.stale === 'targets' ? 'أهدافك اليومية اتغيرت بعد ما الخطة اتعملت.' : 'تفضيلاتك اتغيرت بعد ما الخطة اتعملت.'),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', onclick: () => newPlan(box) }, 'حدّث الخطة'))) : null,
      W.scheduleNote ? notice('info', W.scheduleNote) : null,
      P.household ? notice('info', `متوحدة مع «${P.household.name}»: ${P.household.sharedMeals} وجبة بنفس أكل البيت${P.household.differentMeals ? `، و${P.household.differentMeals} مختلفة علشان تفضيلاتك` : ''}. الجرامات محسوبة ليك انت.`) : null,
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'primary', onclick: (e) => downloadNutritionPdf(e.currentTarget) }, 'تنزيل ملف التغذية PDF'),
        h('a', { class: 'btn', href: '/api/nutrition-file', target: '_blank', rel: 'noopener' }, 'عرض / طباعة'),
        h('button', { type: 'button', onclick: () => showShare(box) }, 'شارك الخطة'),
        W.plan.versionId ? h('button', { type: 'button', onclick: () => showHistory(box) }, 'النسخ السابقة من الخطة') : null),
      h('div', { class: 'card' }, h('h2', {}, 'طريقة تغذيتك'), h('ul', { class: 'approach' }, P.approach.map((x) => h('li', {}, x))),
        h('div', { class: 'item-tags' }, h('span', { class: 'small muted' }, 'وجبات الغدا والعشا الأسبوع ده:'),
          P.proteinMix.map((m) => h('span', { class: 'badge' }, `${m.ar} ${m.meals}`))),
        health ? h('p', { class: 'small' }, P.prefs.health.lowIron ? `حديد ${P.micros.ironMgPerDay} مجم/يوم على الأقل (البيانات تغطي ${P.micros.ironCoveragePct ?? '—'}% من الأكل) · ${P.micros.ironRichMeals} وجبة غنية بالحديد${P.micros.dri ? ` · المطلوب يوميًا (RDA) ${P.micros.dri.ironMg.rda} مجم` : ''}. ` : '',
          P.prefs.health.lowVitD ? `فيتامين د ${P.micros.vitDugPerDay} ميكروجرام/يوم على الأقل (تغطية ${P.micros.vitDCoveragePct ?? '—'}%) · ${P.micros.vitDRichMeals} وجبة غنية بيه${P.micros.dri ? ` · RDA ${P.micros.dri.vitDug.rda} ميكروجرام` : ''}.` : '') : null,
        health ? h('p', { class: 'small muted' }, P.micros.note) : null),
      h('div', { class: 'daychips', role: 'tablist', 'aria-label': 'أيام الأسبوع' }, P.days.map((d, i) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': i === di ? 'true' : 'false', class: i === di ? 'active' : null, onclick: () => { S.wpDay = i; drawWeek(box); } },
          h('span', { class: 'dc-day' }, d.dayAr), h('span', { class: 'dc-date' }, d.date.slice(8) + '/' + Number(d.date.slice(5, 7))),
          h('span', { class: d.training ? 'dc-tag t' : 'dc-tag' }, (W.competitionDates || []).includes(d.date) ? 'بطولة' : d.sessions.length === 2 ? 'حصتين' : d.training ? 'تمرين' : 'راحة')))),
      (W.competitionDates || []).includes(day.date) ? h('div', { class: 'notice info' }, h('strong', {}, 'اليوم ده جزء من خطة البطولة.'),
        h('p', {}, 'في أيام البطولة اتبع خطة البطولة بدل خطتك العادية.'),
        h('button', { type: 'button', onclick: () => { S.nutSub = 'comp'; go('nutrition'); } }, 'افتح خطة البطولة')) : null,
      dayView(day, di, box),
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: () => { S.showGrocery = !S.showGrocery; drawWeek(box); } }, S.showGrocery ? 'إخفاء قايمة المشتريات' : 'قايمة مشتريات الأسبوع'),
        h('button', { type: 'button', onclick: () => newPlan(box) }, 'خطة جديدة')),
      S.showGrocery ? groceryView(P) : null,
      h('p', { class: 'small muted' }, 'الكميات بالجرام لشخص واحد. الأوزان المكتوب جنبها "نيئ" تتوزن قبل الطهي، و"مطهو" بعد الطهي.'));
    const sel = box.querySelector('.daychips button.active');
    if (sel) { const c = sel.parentElement; c.scrollLeft += sel.getBoundingClientRect().left - c.getBoundingClientRect().left - (c.clientWidth - sel.offsetWidth) / 2; }
  }

  function macroLine(t) { return `${Math.round(t.kcal)} سعرة · بروتين ${Math.round(t.protein)} · كارب ${Math.round(t.carb)} · دهون ${Math.round(t.fat)} جم`; }
  async function weekAction(box, method, path, body, okMsg) {
    try { S.wp = await api(method, path, body); await loadIntake(); drawWeek(box); if (okMsg) toast(okMsg); }
    catch (e) { toast(e.data?.message || 'تعذر التنفيذ'); }
  }
  function dayView(day, di, box) {
    const T = day.targets, X = day.totals;
    const cell = (l, v, t) => h('div', { class: 'dt-cell' }, h('span', { class: 'label' }, l), h('strong', {}, `${Math.round(v)}`), h('span', { class: 'small muted' }, `من ${Math.round(t)}`));
    const tags = [day.ramadan ? 'رمضان' : null, day.fasting === 'vegan' ? 'صيامي' : day.fasting === 'fish' ? 'صيامي بالسمك' : null].filter(Boolean);
    const timeline = [...day.meals.map((m) => ({ t: m.timeMin, kind: 'meal', m })),
      ...day.sessions.map((s, i) => ({ t: toMinUI(s.start, day.ramadan), kind: 'session', s, i }))].sort((a, b) => a.t - b.t);
    return h('div', { class: 'card' },
      h('div', { class: 'spread wrap' }, h('h2', {}, `${day.dayAr} ${day.date.slice(8)}/${Number(day.date.slice(5, 7))}`),
        h('span', { class: day.training ? 'badge good' : 'badge' }, day.sessions.length === 2 ? 'يوم حصتين' : day.training ? 'يوم تمرين' : 'يوم راحة'), tags.map((t) => h('span', { class: 'badge' }, t))),
      h('div', { class: 'daytotals' }, cell('سعرات', X.kcal, T.kcal), cell('بروتين جم', X.protein, T.proteinG), cell('كارب جم', X.carb, T.carbG), cell('دهون جم', X.fat, T.fatG)),
      h('p', { class: 'small muted' }, 'الأرقام الكبيرة = أكل الخطة المحسوب، و«من» = الهدف.'),
      day.freeMealBudget ? notice('warn', `الوجبة الحرة مش داخلة في الإجمالي: ميزانيتها حوالي ${day.freeMealBudget.kcal} سعرة (هدف تقريبي، مش أكل محسوب).`) : null,
      intakeCompare(day),
      day.notes.map((n) => notice('info', n)),
      timeline.map((e) => e.kind === 'session'
        ? h('div', { class: 'session-row' }, h('span', { class: 'meal-time' }, e.s.start), h('strong', {}, `تمرين ${day.sessions.length > 1 ? e.i + 1 : ''}`.trim()), h('span', { class: 'small muted' }, ` لحد ${e.s.end} (${e.s.duration} دقيقة)`))
        : [mealCard(e.m, di, box), e.m.empty ? null : logRow(day, `m${e.m.idx}`, box, !!e.m.free)]),
      addedView(day, di, box));
  }
  function toMinUI(hm, ramadan) { const [a, b] = hm.split(':').map(Number); const m = a * 60 + b; return ramadan && m < 12 * 60 ? m + 1440 : m; }

  function addedView(day, di, box) {
    const list = day.added || [];
    const picker = h('div', { class: 'picker', hidden: true });
    const opts = (S.wp.options && S.wp.options.addable) || [];
    const kinds = [['drink', 'مشروبات'], ['snack', 'سناكس'], ['sauce', 'صوصات'], ['dessert', 'حلويات']];
    let kind = 'drink';
    const drawPicker = () => {
      picker.innerHTML = '';
      const avoid = S.wp.prefs.avoid || [];
      const shown = opts.filter((o) => (kind === 'snack' ? !['drink', 'sauce', 'dessert'].includes(o.role) : o.role === kind)
        && !o.allergens.some((a) => avoid.includes(a)) && (day.fasting === 'none' || (day.fasting === 'vegan' ? o.fasting === 'vegan' : o.fasting !== 'none')));
      picker.append(
        h('div', { class: 'seg' }, kinds.map(([k, l]) => h('button', { type: 'button', class: k === kind ? 'active' : null, onclick: () => { kind = k; drawPicker(); } }, l))),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', id: `comp-${di}`, checked: true }), 'عوّض الكربوهيدرات من نشويات وجبة تانية في نفس اليوم'),
        h('ul', { class: 'pick-list' }, shown.map((o) => h('li', {}, h('span', {}, o.ar, h('span', { class: 'small muted' }, ` · ${o.kcal} سعرة · كارب ${o.carb}`)),
          h('button', { type: 'button', class: 'small-btn', onclick: () => weekAction(box, 'POST', '/api/weekplan/extras',
            { day: di, recipeId: o.id, servings: 1, compensate: picker.querySelector(`#comp-${di}`).checked }, `اتضاف ${o.ar}`) }, 'ضيف')))));
    };
    return h('div', { class: 'added' },
      list.length ? [h('h3', {}, 'إضافاتك النهارده'), h('ul', { class: 'pick-list' }, list.map((a) => h('li', {},
        h('span', {}, a.ar, h('span', { class: 'small muted' }, ` · ${macroLine(a.totals)}`),
          a.compensation ? h('div', { class: 'small muted' }, `للتعويض اتشال: ${a.compensation.map((c) => `${c.grams} جم ${c.ar}`).join(' و')}.`) : null),
        h('button', { type: 'button', class: 'ghost small-btn danger', onclick: () => weekAction(box, 'DELETE', `/api/weekplan/extras/${di}/${a.id}`, undefined, 'اتشالت الإضافة') }, 'شيل'),
        logRow(day, `a${a.id}`, box, false))))] : null,
      h('button', { type: 'button', onclick: (e) => { picker.hidden = !picker.hidden; if (!picker.hidden) drawPicker(); e.target.textContent = picker.hidden ? '+ ضيف مشروب أو سناك أو صوص' : 'إخفاء القايمة'; } }, '+ ضيف مشروب أو سناك أو صوص'),
      picker);
  }

  function mealCard(m, di, box) {
    const time = h('span', { class: 'meal-time' }, m.time || '');
    if (m.empty) return h('div', { class: 'meal-card' }, h('div', { class: 'spread' }, h('span', {}, time, ' ', h('span', { class: 'meal-label' }, m.label))), h('p', { class: 'small muted' }, m.note));
    if (m.free) return h('div', { class: 'meal-card free' }, h('div', {}, time, ' ', h('span', { class: 'meal-label' }, m.label)), h('div', { class: 'meal-title' }, 'وجبة حرة'), h('p', { class: 'small' }, m.note));
    const stateAr = { raw: 'نيئ', cooked: 'مطهو', ready: 'جاهز' };
    const rec = S.recipes && S.recipes.recipes.find((r) => r.id === m.recipeId);
    const itemLi = (i) => h('li', {}, h('strong', {}, `${i.grams} جم`), ' ', i.ar, ' ', h('span', { class: 'badge' }, stateAr[i.state] || i.state), i.trust === 'proxy' ? h('span', { class: 'badge warn' }, 'بديل تقريبي') : null);
    const serv = m.servings === 1 ? 'حصة واحدة' : `${m.servings} حصة`;
    return h('div', { class: 'meal-card' + (m.timing ? ' timed' : '') },
      h('div', { class: 'spread' }, h('span', {}, time, ' ', h('span', { class: 'meal-label' }, m.label)),
        h('button', { type: 'button', class: 'ghost small-btn', 'aria-label': `بدّل ${m.recipeAr}`, onclick: async (e) => {
          e.target.disabled = true;
          try { S.wp = await api('POST', '/api/weekplan/swap', { day: di, slot: m.idx }); drawWeek(box); toast('اتبدلت الوجبة'); }
          catch { e.target.disabled = false; toast('مفيش بديل مناسب'); }
        } }, 'بدّل')),
      h('div', { class: 'meal-title' }, m.recipeAr, h('span', { class: 'small muted' }, ` · ${serv}`),
        m.ironRich && S.wp.prefs.health?.lowIron ? h('span', { class: 'badge good' }, 'غني بالحديد') : null,
        m.vitDRich && S.wp.prefs.health?.lowVitD ? h('span', { class: 'badge good' }, 'فيتامين د') : null,
        m.shared ? h('span', { class: 'badge house', title: 'نفس طبق البيت؛ الكمية محسوبة ليك' }, 'أكل البيت') : null),
      m.sharedNote ? h('p', { class: 'small muted' }, m.sharedNote) : null,
      m.extras.length ? h('div', { class: 'meal-extras' }, m.extras.map((e) => h('span', { class: 'extra' },
        e.kind === 'veg' ? `+ ${e.ar}` : `+ ${e.ar}${e.items.length === 1 ? ` ${e.items[0].grams} جم` : ''}`))) : null,
      h('div', { class: 'meal-macros' }, macroLine(m.totals)),
      (['breakfast', 'lunch', 'dinner', 'iftar'].includes(m.slot) || m.slot === 'main') && !m.empty && !m.free ? h('div', { class: 'sauce-ideas' },
        h('button', { type: 'button', class: 'chip', onclick: async (e) => {
          const wrap = e.target.parentNode;
          e.target.disabled = true;
          try {
            const r = await api('GET', `/api/weekplan/sauces/${di}/${m.idx}`);
            wrap.innerHTML = '';
            wrap.append(h('span', { class: 'small muted' }, r.suggestions.length ? 'اختار صوص (بيتحسب في السعرات):' : 'مفيش صوص مناسب لتفضيلاتك النهارده.'),
              ...r.suggestions.slice(0, 8).map((sx) => h('button', { type: 'button', class: sx.pairs ? 'chip active' : 'chip', onclick: () => weekAction(box, 'POST', '/api/weekplan/extras', { day: di, recipeId: sx.id, servings: 1, attachTo: m.idx, compensate: true }, `اتضاف ${sx.ar}`) },
                `${sx.ar} (${sx.kcal} سعرة)`)));
          } catch { e.target.disabled = false; toast('تعذر التحميل'); }
        } }, '+ صوص')) : null,
      h('details', {}, h('summary', {}, 'المكونات والطريقة'),
        h('h3', {}, `${m.recipeAr} (${serv})`), h('ul', { class: 'ingredients' }, m.recipeItems.map(itemLi)),
        m.extras.map((e) => [h('h3', {}, e.ar), h('ul', { class: 'ingredients' }, e.items.map(itemLi))]),
        rec && rec.steps.length ? [h('h3', {}, 'الطريقة'), h('ol', { class: 'steps-list' }, rec.steps.map((s) => h('li', {}, s))),
          h('p', { class: 'small muted' }, `خطوات الوصفة مكتوبة لـ ${rec.servings} ${rec.servings === 1 ? 'حصة' : 'حصص'}؛ استخدم الكميات اللي فوق (محسوبة لـ ${serv}) واتبع نفس الخطوات.`)] : null));
  }

  function groceryView(P, title = 'قايمة مشتريات الأسبوع') {
    const groups = {};
    P.grocery.forEach((g) => { (groups[g.group] ||= []).push(g); });
    const stateAr = { raw: 'نيئ', cooked: 'مطهو', ready: 'جاهز' };
    return h('div', { class: 'card' }, h('h2', {}, title),
      h('p', { class: 'small muted' }, 'مجموع الكميات اللي في الخطة للأسبوع كله، ومعاها إضافاتك. الأوزان "المطهوة" (زي الأرز والمكرونة) معناها الكمية بعد الطهي.'),
      Object.entries(groups).map(([g, list]) => h('div', { class: 'grocery-group' }, h('h3', {}, g),
        h('ul', { class: 'grocery' }, list.map((i) => h('li', {}, h('span', {}, i.ar, ' ', h('span', { class: 'badge' }, stateAr[i.state] || i.state)),
          h('strong', {}, i.grams >= 1000 ? `${(i.grams / 1000).toFixed(1)} كجم` : `${i.grams} جم`, i.units ? h('span', { class: 'small muted' }, ` ${i.units}`) : null)))))));
  }

  // ---------- championship ----------
  function competitionCard() {
    const box = h('div', {}, h('p', { class: 'muted' }, 'جارٍ التحميل…'));
    api('GET', '/api/competition').then((r) => drawCompetition(box, r.competition)).catch(() => { box.textContent = 'تعذر التحميل.'; });
    return box;
  }
  function drawCompetition(box, comp) {
    const today = S.meta.today;
    const wk = new Date(today + 'T00:00:00Z'); wk.setUTCDate(wk.getUTCDate() + 7);
    const f = comp ? JSON.parse(JSON.stringify(comp.input)) : { name: '', raceDurationMin: 3, days: [{ date: wk.toISOString().slice(0, 10), races: ['10:00'] }] };
    let errors = {};
    let editing = !comp;
    const draw = () => {
      box.innerHTML = '';
      const add = (...k) => box.append(...k.flat(Infinity).filter(Boolean));
      if (comp && !editing) {
        const P = comp.plan;
        add(h('div', { class: 'card' }, h('div', { class: 'spread wrap' }, h('h2', {}, P.name), h('span', { class: 'badge' }, `${P.sportAr} · ${P.weightKg} كجم`)),
            h('ul', { class: 'approach' }, P.principles.map((x) => h('li', {}, x))),
            h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => { editing = true; draw(); } }, 'عدّل المواعيد'),
              h('button', { type: 'button', class: 'danger', onclick: async () => { await api('DELETE', '/api/competition'); comp = null; editing = true; draw(); toast('اتشالت البطولة'); } }, 'امسح البطولة'))),
          P.days.map((d) => h('div', { class: 'card' },
            h('div', { class: 'spread wrap' }, h('h2', {}, `${d.dayAr} ${d.date.slice(8)}/${Number(d.date.slice(5, 7))}`), h('span', { class: d.phase === 'race' ? 'badge good' : 'badge' }, d.phaseAr)),
            h('p', { class: 'small muted' }, `المجموع: ${macroLine(d.totals)}`),
            d.notes.map((n) => h('p', { class: 'small' }, n)),
            d.meals.map((m) => h('div', { class: 'meal-card' + (m.kind !== 'meal' && m.kind !== 'snack' ? ' timed' : '') },
              h('div', {}, h('span', { class: 'meal-time' }, m.time), ' ', h('span', { class: 'meal-label' }, m.label)),
              h('ul', { class: 'ingredients' }, m.items.filter((i) => i.foodId !== 'salt').map((i) => h('li', {}, h('strong', {}, i.foodId === 'water' ? `${i.grams} مل` : `${i.grams} جم`), ' ', i.ar))),
              h('div', { class: 'meal-macros' }, macroLine(m.totals)),
              m.notes.map((n) => h('p', { class: 'small muted' }, n)))))));
        return;
      }
      const err = (k) => errors[k] ? h('div', { class: 'field-error' }, errors[k]) : null;
      add(h('div', { class: 'card' }, h('h2', {}, 'خطة تغذية البطولة'),
        h('p', { class: 'small muted' }, 'اكتب أيام البطولة ومواعيد سباقاتك بالظبط. هنعملك تحميل كربوهيدرات قبلها بيومين، ووجبات قبل كل سباق وبين السباقات وبعدها بمواعيد، ويوم استشفاء بعدها.'),
        h('label', { for: 'c-name' }, 'اسم البطولة'), h('input', { id: 'c-name', value: f.name, placeholder: 'بطولة الجمهورية', oninput: (e) => { f.name = e.target.value; } }),
        h('label', { for: 'c-dur' }, 'مدة السباق الواحد تقريبًا (دقيقة)'), h('input', { id: 'c-dur', type: 'number', inputmode: 'numeric', value: f.raceDurationMin, oninput: (e) => { f.raceDurationMin = Number(e.target.value); } }), err('raceDurationMin'),
        f.days.map((d, i) => h('div', { class: 'comp-day' },
          h('div', { class: 'spread' }, h('strong', {}, `يوم ${i + 1}`), f.days.length > 1 ? h('button', { type: 'button', class: 'ghost small-btn danger', onclick: () => { f.days.splice(i, 1); draw(); } }, 'شيل اليوم') : null),
          h('input', { type: 'date', value: d.date, min: today, 'aria-label': `تاريخ يوم ${i + 1}`, onchange: (e) => { d.date = e.target.value; } }),
          h('div', { class: 'times' }, d.races.map((t, j) => h('span', { class: 'time-item' },
            h('input', { type: 'time', value: t, 'aria-label': `ميعاد سباق ${j + 1}`, onchange: (e) => { d.races[j] = e.target.value; } }),
            d.races.length > 1 ? h('button', { type: 'button', class: 'ghost small-btn', 'aria-label': 'شيل السباق', onclick: () => { d.races.splice(j, 1); draw(); } }, '×') : null)),
            d.races.length < 8 ? h('button', { type: 'button', class: 'small-btn', onclick: () => { d.races.push('16:00'); draw(); } }, '+ سباق') : null),
          err(`days.${i}`))),
        f.days.length < 7 ? h('button', { type: 'button', onclick: () => { const last = f.days[f.days.length - 1].date; const nd = new Date(last + 'T00:00:00Z'); nd.setUTCDate(nd.getUTCDate() + 1); f.days.push({ date: nd.toISOString().slice(0, 10), races: ['10:00'] }); draw(); } }, '+ يوم بطولة') : null,
        err('days'),
        h('div', { class: 'actions' },
          comp ? h('button', { type: 'button', onclick: () => { editing = false; draw(); } }, 'رجوع') : null,
          h('button', { type: 'button', class: 'primary', onclick: async () => {
            try { const r = await api('PUT', '/api/competition', f); comp = r.competition; editing = false; errors = {}; draw(); toast('اتعملت خطة البطولة'); }
            catch (ex) { errors = ex.data?.errors || {}; draw(); }
          } }, 'اعمل خطة البطولة'))));
    };
    draw();
  }

  // ---------- preferences ----------
  function prefsCard() {
    const box = h('div', {}, h('p', { class: 'muted' }, 'جارٍ التحميل…'));
    api('GET', '/api/prefs').then((r) => drawPrefs(box, r)).catch(() => { box.textContent = 'تعذر التحميل.'; });
    return box;
  }
  // Display only (same table as weekplan.sleepAdvice — kealy2023): sleep hours and the age recommendation. Never blocks.
  function sleepLine(p) {
    const tm = (x) => { const [a, b] = x.split(':').map(Number); return a * 60 + b; };
    const awake = (tm(p.sleepTime) - tm(p.wakeTime) + 1440) % 1440;
    const hrs = Math.round(((1440 - awake) / 60) * 10) / 10;
    const age = S.st?.goal?.input?.age;
    const rec = age == null ? null : age < 13 ? [9, 12] : age <= 18 ? [8, 10] : age <= 60 ? [7, null] : age <= 64 ? [7, 9] : [7, 8];
    const low = (rec && hrs < rec[0]) || hrs < 8;
    return h('p', { class: low ? 'small warn-text' : 'small muted' }, `نومك ${hrs} ساعة`,
      rec ? ` · الموصى بيه لسنك ${rec[1] ? `${rec[0]}–${rec[1]}` : `${rec[0]}+`} ساعات` : '',
      hrs < 8 ? ' · أقل من 8 ساعات بيزود خطر الإصابة عند الرياضيين.' : '');
  }

  function drawPrefs(box, R) {
    const p = JSON.parse(JSON.stringify(R.prefs));
    const O = R.options;
    let phase = S.st.goal.input.seasonPhase || 'pre_season';
    const phase0 = phase;
    let errors = {};
    const LEVELS = [[-1, 'مش باكله'], [0, 'نادرًا'], [1, 'عادي'], [2, 'بحبه']];
    const WEEK = [6, 0, 1, 2, 3, 4, 5];
    const DUR = S.st.goal.input.minutesPerSession || 60;
    const draw = () => {
      box.innerHTML = '';
      const seg = (opts, cur, set, label) => h('div', { class: 'seg pref-seg', role: 'radiogroup', 'aria-label': label },
        opts.map(([v, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': cur === v ? 'true' : 'false', class: cur === v ? 'active' : null, onclick: () => { set(v); draw(); } }, l)));
      const chips = (opts, arr, label) => h('div', { class: 'chips', role: 'group', 'aria-label': label },
        opts.map(([v, l]) => h('button', { type: 'button', 'aria-pressed': arr.includes(v) ? 'true' : 'false', class: arr.includes(v) ? 'chip on' : 'chip',
          onclick: () => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); draw(); } }, l)));
      const err = (k) => errors[k] ? h('div', { class: 'field-error' }, errors[k]) : null;
      const timeIn = (val, set, label, id) => h('input', { type: 'time', id, value: val, 'aria-label': label, onchange: (e) => set(e.target.value) });
      const check = (val, set, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: val, onchange: (e) => { set(e.target.checked); draw(); } }), label);
      box.append(...[
        h('div', { class: 'card' }, h('h2', {}, 'جدول التمرين'),
          h('p', { class: 'small muted' }, 'اكتب ميعاد بداية كل حصة ومدتها بالظبط (حصتين بالكتير في اليوم)؛ مواعيد الوجبات وكمياتها بتتحسب منها.'),
          WEEK.map((d) => {
            const list = p.schedule[d] || [];
            return h('div', { class: 'sched-row' }, h('span', { class: 'pref-name' }, O.days[d]),
              h('div', { class: 'times' },
                list.map((s, j) => h('span', { class: 'time-item' },
                  timeIn(s.start, (v) => { s.start = v; }, `ميعاد حصة ${j + 1} يوم ${O.days[d]}`),
                  h('select', { 'aria-label': 'مدة الحصة', onchange: (e) => { s.duration = Number(e.target.value); } },
                    [30, 45, 60, 75, 90, 105, 120, 150, 180].map((m) => h('option', { value: m, selected: s.duration === m || null }, `${m} د`))),
                  h('button', { type: 'button', class: 'ghost small-btn', 'aria-label': 'شيل الحصة', onclick: () => { list.splice(j, 1); if (!list.length) delete p.schedule[d]; draw(); } }, '×'))),
                list.length < 2 ? h('button', { type: 'button', class: 'small-btn', onclick: () => {
                  const nl = p.schedule[d] || (p.schedule[d] = []);
                  let start = '16:00';
                  if (nl.length) {
                    const [hh, mm] = nl[0].start.split(':').map(Number);
                    const s0 = hh * 60 + mm;
                    let t = s0 + nl[0].duration + 240;
                    if (t > 21 * 60) t = Math.max(5 * 60, s0 - DUR - 240);
                    start = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
                  }
                  nl.push({ start, duration: DUR }); nl.sort((a, c) => a.start.localeCompare(c.start)); draw();
                } }, list.length ? '+ حصة تانية' : '+ حصة') : null),
              err(`schedule.${d}`));
          }),
          h('div', { class: 'row' },
            h('div', {}, h('label', { for: 'p-wake' }, 'بتصحى الساعة كام'), timeIn(p.wakeTime, (v) => { p.wakeTime = v; draw(); }, 'ميعاد الصحيان', 'p-wake')),
            h('div', {}, h('label', { for: 'p-sleep' }, 'بتنام الساعة كام'), timeIn(p.sleepTime, (v) => { p.sleepTime = v; draw(); }, 'ميعاد النوم', 'p-sleep'))), err('sleepTime'),
          sleepLine(p),
          S.st.goal.input.isAthlete === false ? null : h('label', {}, 'مرحلة الموسم'),
          S.st.goal.input.isAthlete === false ? null : seg(Object.entries(O.seasonPhases), phase, (v) => { phase = v; }, 'مرحلة الموسم'),
          phase !== phase0 ? h('p', { class: 'small muted' }, 'تغيير المرحلة هيعيد حساب المعدل الأسبوعي الآمن والسعرات من النهارده.') : null),
        h('div', { class: 'card' }, h('h2', {}, 'البروتين اللي بتحبه'),
          h('p', { class: 'small muted' }, 'الخطة بتكرر اللي بتحبه أكتر، وبتقلل "نادرًا"، و"مش باكله" مش هيظهر خالص.'),
          Object.entries(O.proteinTypes).map(([k, l]) => h('div', { class: 'pref-row' }, h('span', { class: 'pref-name' }, l),
            seg(LEVELS, p.proteins[k], (v) => { p.proteins[k] = v; }, l))), err('proteins')),
        h('div', { class: 'card' }, h('h2', {}, 'مصادر الكربوهيدرات'), chips(Object.entries(O.carbSources), p.carbs, 'مصادر الكربوهيدرات'), err('carbs'),
          h('h3', {}, 'حساسية أو أكل ممنوع'), chips(Object.entries(O.allergens), p.avoid, 'الممنوعات'),
          h('p', { class: 'small muted' }, 'أي وصفة فيها مكوّن ممنوع مش هتظهر في الخطة.')),
        h('div', { class: 'card' }, h('h2', {}, 'نظام الأكل'),
          h('label', {}, 'عدد الوجبات في اليوم'), seg([[3, '3'], [4, '4'], [5, '5'], [6, '6']], p.mealsPerDay, (v) => { p.mealsPerDay = v; }, 'عدد الوجبات'), err('mealsPerDay'),
          h('label', {}, 'توزيع الكربوهيدرات'), seg([['periodized', 'حسب التمرين (موصى به)'], ['even', 'ثابت كل يوم']], p.carbStrategy, (v) => { p.carbStrategy = v; }, 'توزيع الكربوهيدرات'),
          h('label', {}, 'أقصى وقت للتحضير والطهي'), seg([[null, 'أي وقت'], [20, '20 د'], [30, '30 د'], [45, '45 د'], [60, 'ساعة']], p.maxCookMin, (v) => { p.maxCookMin = v; }, 'وقت الطهي'),
          h('label', {}, 'حلويات في الأسبوع'), seg([[0, '0'], [1, '1'], [2, '2'], [3, '3']], p.dessertsPerWeek, (v) => { p.dessertsPerWeek = v; }, 'الحلويات')),
        h('div', { class: 'card' }, h('h2', {}, 'صيام ورمضان'),
          h('label', {}, 'صيامي'), seg([['none', 'لا'], ['fish', 'صيام بالسمك'], ['vegan', 'صيام كامل (نباتي)']], p.fasting.mode, (v) => { p.fasting.mode = v; }, 'الصيام'),
          p.fasting.mode !== 'none' ? [h('p', { class: 'small muted' }, 'أيام الصيام (لو مختارتش أيام، يبقى كل الأيام):'), chips(WEEK.map((d) => [d, O.days[d]]), p.fasting.days, 'أيام الصيام')] : null,
          err('fasting'),
          check(p.ramadan.enabled, (v) => { p.ramadan.enabled = v; }, 'رمضان (الوجبات بين الإفطار والسحور)'),
          p.ramadan.enabled ? h('div', { class: 'row' },
            h('div', {}, h('label', { for: 'p-iftar' }, 'ميعاد الإفطار (المغرب)'), timeIn(p.ramadan.iftarTime, (v) => { p.ramadan.iftarTime = v; }, 'ميعاد الإفطار', 'p-iftar')),
            h('div', {}, h('label', { for: 'p-suhoor' }, 'آخر ميعاد للسحور (الفجر)'), timeIn(p.ramadan.suhoorTime, (v) => { p.ramadan.suhoorTime = v; }, 'ميعاد السحور', 'p-suhoor'))) : null,
          err('ramadan')),
        h('div', { class: 'card' }, h('h2', {}, 'حالات صحية (بتشخيص وتحليل)'),
          check(p.health.lowIron, (v) => { p.health.lowIron = v; }, 'نقص الحديد'),
          check(p.health.lowVitD, (v) => { p.health.lowVitD = v; }, 'نقص فيتامين د'),
          h('p', { class: 'small muted' }, 'الخطة بتكتّر الأكل الغني بيهم ومعاها نصايح امتصاص. المكملات وجرعاتها يحددها الطبيب، والتطبيق مش بديل عن المتابعة.')),
        h('div', { class: 'card' }, h('h2', {}, 'الوجبة الحرة'),
          check(p.freeMeal.enabled, (v) => { p.freeMeal.enabled = v; if (v && !p.freeMeal.date) p.freeMeal.date = S.meta.today; }, 'وجبة حرة مرة في الشهر'),
          p.freeMeal.enabled ? [h('div', { class: 'row' },
            h('div', {}, h('label', { for: 'p-free' }, 'تاريخها'), h('input', { type: 'date', id: 'p-free', value: p.freeMeal.date || '', min: S.meta.today, onchange: (e) => { p.freeMeal.date = e.target.value; } })),
            h('div', {}, h('label', {}, 'الوجبة'), seg([['lunch', 'الغدا'], ['dinner', 'العشا']], p.freeMeal.slot, (v) => { p.freeMeal.slot = v; }, 'الوجبة الحرة'))),
            h('p', { class: 'small muted' }, 'بعد ما تعدي، اختار تاريخ الشهر الجاي. يفضل متبقاش قبل بطولة أو في يوم حصتين.')] : null,
          err('freeMeal')),
        Object.keys(errors).length ? notice('bad', 'راجع الاختيارات', Object.values(errors)) : null,
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api('PUT', '/api/prefs', p);
            if (phase !== phase0) S.st = await api('PUT', '/api/goal/season', { seasonPhase: phase });
            S.wp = await api('POST', '/api/weekplan'); S.wpDay = 0;
            toast('اتحفظت التفضيلات واتعملت خطة جديدة'); S.nutSub = 'week'; go('nutrition');
          } catch (ex) { errors = ex.data?.errors || { _: ex.data?.message || 'تعذر الحفظ.' }; draw(); }
        } }, 'احفظ واعمل خطة الأسبوع')),
      ].flat(Infinity).filter(Boolean));
    };
    draw();
  }

  // ---------- recipe library ----------
  function recipesCard() {
    const card = h('div', { class: 'card', id: 'recipes' }, h('h2', {}, 'وصفات محسوبة'), h('p', { class: 'muted small' }, 'جارٍ التحميل…'));
    const draw = () => {
      const L = S.recipes, q = (S.recipeQuery || '').trim();
      const cat = S.recipeCat || 'all';
      const prot = S.recipeProt || 'all';
      const list = L.recipes.filter((r) => (cat === 'all' || r.category === cat) && (prot === 'all' || r.plan.proteinType === prot)
        && (!q || r.ar.includes(q) || r.items.some((i) => i.ar.includes(q))));
      const search = h('input', { type: 'search', placeholder: 'ابحث باسم الطبق أو مكوّن (مثلاً: عسل، زبادي)', value: S.recipeQuery || '', 'aria-label': 'بحث في الوصفات',
        oninput: (e) => { S.recipeQuery = e.target.value; const pos = e.target.selectionStart; draw(); const el = card.querySelector('input[type=search]'); el.focus(); el.setSelectionRange(pos, pos); } });
      card.innerHTML = '';
      const kids = [
        h('h2', {}, 'وصفات محسوبة'),
        h('p', { class: 'small muted' }, `${L.recipes.length} وصفة. المكونات معروضة للحصة الواحدة، وتقدر تغيّر عدد الحصص. ${L.meta.weights}`),
        h('div', { class: 'seg' }, [['all', 'الكل'], ...Object.entries(L.categories)].map(([k, l]) =>
          h('button', { type: 'button', class: cat === k ? 'active' : null, onclick: () => { S.recipeCat = k; draw(); } }, l))),
        h('div', { class: 'seg prot-seg' }, [['all', 'كل البروتينات'], ...Object.entries(L.proteinTypes).filter(([k]) => k !== 'mixed')].map(([k, l]) =>
          h('button', { type: 'button', class: prot === k ? 'active' : null, onclick: () => { S.recipeProt = k; draw(); } }, l))),
        h('div', { class: 'recipe-search' }, search),
        h('p', { class: 'small muted' }, `${list.length} وصفة`),
        list.length ? list.map(recipeView) : h('p', { class: 'muted' }, 'لا توجد نتائج.'),
        h('p', { class: 'small muted' }, L.meta.safety),
        h('p', { class: 'small muted' }, L.meta.note)];
      card.append(...kids.flat(Infinity).filter(Boolean));
      const act = card.querySelector('.seg:not(.prot-seg) button.active');
      if (act) { const seg = act.parentElement; seg.scrollLeft += act.getBoundingClientRect().left - seg.getBoundingClientRect().left - (seg.clientWidth - act.offsetWidth) / 2; }
    };
    if (S.recipes) draw();
    else api('GET', '/api/recipes').then((r) => { S.recipes = r; draw(); }).catch(() => { card.lastChild.textContent = 'تعذر تحميل الوصفات.'; });
    return card;
  }

  // Ingredients are shown per serving; the stepper scales to any number of servings.
  function recipeView(r) {
    const p = r.perServing;
    const stateAr = { raw: 'نيئ', cooked: 'مطهو', ready: 'جاهز' };
    const time = [r.prepMin && `تحضير ${r.prepMin} د`, r.cookMin && `طهي ${r.cookMin} د`, r.ovenC && `فرن ${r.ovenC}°م`].filter(Boolean).join(' · ');
    const body = h('div', { class: 'recipe-body' });
    let n = 1;
    const g = (grams) => { const v = (grams / r.servings) * n; return v >= 10 ? Math.round(v) : Math.round(v * 2) / 2; };
    const drawBody = () => {
      body.innerHTML = '';
      const tot = { kcal: p.kcal * n, protein: p.protein * n, carb: p.carb * n, fat: p.fat * n, fiber: p.fiber * n };
      body.append(...[
        h('div', { class: 'item-tags' }, time ? h('span', { class: 'small muted' }, time) : null,
          r.estimate ? h('span', { class: 'badge warn' }, 'قيم تقديرية غير مراجعة') : null,
          r.plan.fasting === 'vegan' ? h('span', { class: 'badge' }, 'صيامي') : r.plan.fasting === 'fish' ? h('span', { class: 'badge' }, 'صيامي بالسمك') : null,
          r.plan.ironRich ? h('span', { class: 'badge good' }, 'غني بالحديد') : null, r.plan.vitDRich ? h('span', { class: 'badge good' }, 'فيتامين د') : null),
        h('div', { class: 'stepper' }, h('span', {}, 'عدد الحصص'),
          h('button', { type: 'button', class: 'small-btn', 'aria-label': 'قلل الحصص', disabled: n <= 1 || null, onclick: () => { n = Math.max(1, n - 1); drawBody(); } }, '−'),
          h('strong', { 'aria-live': 'polite' }, String(n)),
          h('button', { type: 'button', class: 'small-btn', 'aria-label': 'زوّد الحصص', disabled: n >= 12 || null, onclick: () => { n = Math.min(12, n + 1); drawBody(); } }, '+'),
          n !== r.servings ? h('button', { type: 'button', class: 'ghost small-btn', onclick: () => { n = r.servings; drawBody(); } }, `الوصفة كاملة (${r.servings})`) : null),
        h('h3', {}, n === 1 ? 'المكونات للحصة الواحدة' : `المكونات لـ ${n} حصص`),
        h('ul', { class: 'ingredients' }, r.items.filter((i) => i.foodId !== 'salt').map((i) => h('li', {}, h('strong', {}, `${g(i.grams)} جم`), ' ', i.ar, ' ',
          h('span', { class: 'badge' }, stateAr[i.state] || i.state), i.trust === 'proxy' ? h('span', { class: 'badge warn', title: i.source }, 'بديل تقريبي') : null))),
        r.oilG ? h('p', { class: 'small muted' }, `الزيت/الدهون المضافة: ${g(r.oilG)} جم`) : null,
        r.steps.length ? [h('h3', {}, 'الطريقة'), h('ol', { class: 'steps-list' }, r.steps.map((s) => h('li', {}, s)))] : (r.method ? h('p', {}, r.method) : null),
        r.servings !== n && r.steps.length ? h('p', { class: 'small muted' }, `الخطوات مكتوبة للوصفة كاملة (${r.servings} ${r.servings === 1 ? 'حصة' : 'حصص'})؛ استخدم الكميات اللي فوق بنفس الطريقة، ووقت الطهي ممكن يقل مع الكمية الصغيرة.`) : null,
        r.tips.length ? h('ul', { class: 'small muted' }, r.tips.map((t) => h('li', {}, t))) : null,
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, ''), ...['سعرات', 'بروتين', 'كارب', 'دهون', 'ألياف'].map((x) => h('th', { class: 'n' }, x)))),
          h('tbody', {},
            h('tr', {}, h('th', {}, 'الحصة'), ...[p.kcal, p.protein, p.carb, p.fat, p.fiber].map((v) => h('td', { class: 'n' }, String(v)))),
            n > 1 ? h('tr', {}, h('th', {}, `${n} حصص`), ...[tot.kcal, tot.protein, tot.carb, tot.fat, tot.fiber].map((v) => h('td', { class: 'n' }, String(Math.round(v))))) : null))),
      ].flat(Infinity).filter(Boolean));
    };
    const d = h('details', { class: 'recipe', ontoggle: () => { if (d.open && !body.childNodes.length) drawBody(); } },
      h('summary', {}, h('span', { class: 'recipe-title' }, r.ar),
        h('span', { class: 'recipe-macros' }, `${p.kcal} سعرة · بروتين ${p.protein} · كارب ${p.carb} · دهون ${p.fat} جم — للحصة`)),
      body);
    return d;
  }

  function adjustmentCard(st) {
    const p = st.pending;
    const log = st.adjustments.filter((a) => a.status !== 'pending').slice().reverse();
    return h('div', { class: 'card' }, h('h2', {}, 'التعديل التكيفي'),
      h('p', { class: 'small muted' }, 'نقارن اتجاه متوسط وزنك على عدة أسابيع بالمعدل المخطط. لا نغير السعرات تلقائيًا؛ أنت من يقبل أو يرفض.'),
      p ? h('div', { class: 'notice warn' }, h('strong', {}, `اقتراح: ${p.kcalChange > 0 ? '+' : ''}${p.kcalChange} سعرة/يوم`),
        h('ul', {}, p.reasons.map((r) => h('li', {}, r))),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'primary', onclick: () => decide(p.id, 'accepted') }, 'قبول التعديل'),
          h('button', { type: 'button', onclick: () => decide(p.id, 'rejected') }, 'رفض'))) :
        h('button', { type: 'button', onclick: evaluateNow }, 'قيّم الأسبوع واقترح تعديلًا إن لزم'),
      st.evaluation.checklist?.length ? notice('info', 'قبل أي تعديل في السعرات راجع:', st.evaluation.checklist) : null,
      log.length ? h('details', {}, h('summary', {}, `سجل التعديلات (${log.length})`),
        log.map((a) => h('div', { class: 'list-item' }, h('div', {},
          h('div', {}, h('span', { class: 'badge' }, t(`status.${a.status}`)), ' ', a.kcalChange ? `${a.kcalChange > 0 ? '+' : ''}${a.kcalChange} سعرة` : '', ' · ', h('span', { class: 'small muted' }, a.createdAt.slice(0, 10))),
          h('div', { class: 'small' }, a.reasons.join(' ')))))) : null);
  }
  async function evaluateNow() {
    try {
      const r = await api('POST', '/api/adjustments/evaluate');
      S.st = r.state;
      toast(r.proposalId ? 'تم إنشاء اقتراح تعديل' : t(`action.${r.evaluation.action}`));
      go('nutrition');
    } catch { toast('تعذر التقييم'); }
  }
  async function decide(id, decision) {
    try { S.st = await api('POST', `/api/adjustments/${id}/decision`, { decision }); toast(decision === 'accepted' ? 'تم تطبيق التعديل' : 'تم رفض الاقتراح'); go('nutrition'); }
    catch (e) { toast(e.data?.problems?.[0] || 'تعذر تنفيذ القرار'); }
  }

  function mealPlanView(plan) {
    const stateAr = { raw: 'نيئ', cooked: 'مطهو', ready: 'جاهز' };
    return h('div', {},
      plan.meals.map((m) => h('div', { class: 'meal' },
        h('div', { class: 'spread' }, h('strong', {}, m.ar), h('span', { class: 'small muted' }, `${m.totals.kcal} سعرة · بروتين ${m.totals.protein} جم`)),
        m.method ? h('div', { class: 'method' }, m.method, m.oilG ? ` · زيت مضاف ${m.oilG} جم` : '') : null,
        h('div', { class: 'items' }, m.items.map((i) => h('div', { class: 'item' },
          h('div', { class: 'spread' }, h('span', { class: 'item-name' }, i.ar), h('strong', {}, `${i.grams} جم`)),
          h('div', { class: 'item-tags' }, h('span', { class: 'badge' }, stateAr[i.state] || i.state),
            i.trust === 'proxy' ? h('span', { class: 'badge warn', title: i.source }, 'بديل تقريبي') : null,
            i.units ? h('span', { class: 'small muted' }, i.units) : null),
          h('div', { class: 'item-macros' }, `${i.kcal} سعرة · بروتين ${i.protein} · كارب ${i.carb} · دهون ${i.fat} · ألياف ${i.fiber ?? '—'} (جم)`),
          i.note ? h('div', { class: 'small muted' }, i.note) : null))))),
      h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {},
        h('tr', { class: 'total' }, h('td', {}, 'إجمالي اليوم'), ...[plan.totals.kcal, plan.totals.protein, plan.totals.carb, plan.totals.fat, plan.totals.fiber].map((v) => h('td', { class: 'n' }, String(v)))),
        h('tr', {}, h('td', {}, 'الهدف'), ...[plan.targets.kcal, plan.targets.proteinG, plan.targets.carbG, plan.targets.fatG, plan.targets.fiberG].map((v) => h('td', { class: 'n' }, String(v))))))),
      h('ul', { class: 'small muted' }, plan.notes.map((x) => h('li', {}, x))),
      h('p', { class: 'small muted' }, `المصدر: ${S.meta.foodsMeta.primarySource}. لا يعرض التطبيق تكلفة الطعام لعدم توفر بيانات أسعار موثقة.`));
  }

  // ---------- more ----------
  async function renderMore() {
    append(h('h1', {}, 'المزيد'),
      subCard(),
      proCard(),
      householdCard(),
      dataCard(),
      S.isOwner ? h('div', { class: 'card' }, h('h2', {}, 'إدارة الاشتراكات'), h('p', { class: 'small muted' }, 'تسجيل الدفع وتمديد أو إلغاء اشتراك أي مستخدم.'),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', onclick: () => { S.teamView = drawOwner; go('team'); } }, 'فتح'))) : null,
      h('div', { class: 'card' }, h('h2', {}, 'الأكاديمية والفريق'),
        h('p', { class: 'small muted' }, 'انضم لأكاديمية بكود، أو أنشئ أكاديمية، وتحكم في مين يشوف بياناتك الصحية.'),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', onclick: () => go('team') }, 'فتح'))),
      h('div', { class: 'card' }, h('h2', {}, 'تقرير التقدم'),
        h('p', { class: 'small muted' }, 'تقرير قابل للطباعة أو الحفظ PDF من المتصفح، وملف CSV للبيانات الأسبوعية.'),
        h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '/api/report', target: '_blank', rel: 'noopener' }, 'فتح التقرير'), h('a', { class: 'btn', href: '/api/export.csv' }, 'تنزيل CSV'))),
      h('div', { class: 'card' }, h('h2', {}, 'الهدف'),
        h('p', { class: 'small muted' }, 'تعديل الهدف ينشئ خطة جديدة تبدأ اليوم؛ الخطة الحالية تُحفظ في السجل.'),
        h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => startWizard(S.st.goal.input) }, 'تعديل الهدف / خطة جديدة'), h('button', { type: 'button', onclick: recalc }, 'إعادة حساب الاحتياجات'))));
    const box = h('div', { class: 'card' }, h('h2', {}, 'إعدادات التنبيهات'), h('p', { class: 'muted small' }, 'جارٍ التحميل…'));
    append(box, h('div', { class: 'card' }, h('p', { class: 'small muted' }, S.me?.email || ''), h('button', { type: 'button', class: 'danger', onclick: async () => { await api('POST', '/api/auth/logout'); S.me = null; S.st = null; renderAuth('login'); } }, 'تسجيل الخروج')),
      h('p', { class: 'small muted center' }, 'أكلني (Eklni) أداة تخطيط تقديرية ولا تغني عن أخصائي تغذية رياضية أو طبيب.'));
    const r = await api('GET', '/api/notifications');
    const s = { ...r.settings };
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    box.innerHTML = '';
    put(box, h('h2', {}, 'إعدادات التنبيهات'),
      h('p', { class: 'small muted' }, 'التنبيهات بتوصل لصندوق التنبيهات في الصفحة الرئيسية. الحفظ هنا بيغيّر التفضيلات بس.'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.weighInReminder, onchange: (e) => { s.weighInReminder = e.target.checked; } }), 'تذكير يومي بالوزن'),
      h('label', {}, 'وقت التذكير'), h('input', { type: 'time', value: s.weighInTime, onchange: (e) => { s.weighInTime = e.target.value; } }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.weeklyCheckinReminder, onchange: (e) => { s.weeklyCheckinReminder = e.target.checked; } }), 'تذكير بالمراجعة الأسبوعية'),
      h('label', {}, 'يوم المراجعة'), h('select', { onchange: (e) => { s.weeklyCheckinDay = Number(e.target.value); } }, days.map((d, i) => h('option', { value: i, selected: s.weeklyCheckinDay === i || null }, d))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.adjustmentAlerts, onchange: (e) => { s.adjustmentAlerts = e.target.checked; } }), 'تنبيه عند وجود اقتراح تعديل'),
      r.channels && r.channels.external ? h('div', {},
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.externalChannel, onchange: (e) => { s.externalChannel = e.target.checked; } }), 'ابعتلي التنبيهات برسالة كمان (من غير أي أرقام صحية)'),
        h('input', { value: s.externalAddress || '', placeholder: 'رقم الموبايل أو الإيميل', dir: 'ltr', oninput: (e) => { s.externalAddress = e.target.value; } })) : null,
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', onclick: async () => { try { await api('PUT', '/api/notifications', s); toast('تم حفظ التفضيلات'); } catch (ex) { toast(errMsg(ex)); } } }, 'حفظ')));
  }

  // ---------- plan history ----------
  const REASON_AR = { generated: 'خطة جديدة', swap: 'تبديل وجبة', extra_add: 'إضافة مشروب/سناك', extra_remove: 'حذف إضافة' };
  // Download the nutrition file as a real .pdf: from the server (Chromium) when it is set up, otherwise built
  // in the browser (public/pdfexport.js). The demo supplies the page and the save step through window hooks.
  async function downloadNutritionPdf(btn) {
    const name = `eklni-nutrition-${S.meta.today}.pdf`;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'بنجهّز الملف…';
    try {
      let bytes;
      if (S.meta.pdfDownload) {
        const res = await fetch('/api/nutrition-file.pdf', { credentials: 'same-origin' });
        if (res.status === 402) { renderLocked(await res.json()); return; }
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || '');
        bytes = new Uint8Array(await res.arrayBuffer());
      } else {
        if (!window.EklniPdf) throw new Error('');
        const html = window.__eklniNutritionHtml ? window.__eklniNutritionHtml() : undefined;
        if (html === null) throw new Error('اعمل خطة الأسبوع الأول.');
        bytes = (await window.EklniPdf.nutritionPdf(html ? { html } : { url: '/api/nutrition-file' })).bytes;
      }
      const r = await saveFile(name, bytes, 'application/pdf');
      toast(r === 'saved' ? 'اتحفظ ملف التغذية PDF' : r === 'declined' ? 'اتلغى التنزيل' : 'لو التنزيل ما بدأش، افتح الصفحة في متصفح (Chrome) وجرّب تاني.');
    } catch (e) {
      const code = e && e.code ? ` (${e.code})` : '';
      toast(e && e.message && !e.code ? e.message : `تعذر عمل الملف على الجهاز ده${code}؛ ابعتلنا الكود ده، واستخدم «عرض / طباعة» مؤقتًا.`);
    } finally { btn.disabled = false; btn.textContent = label; }
  }
  window.__eklniDownloadPdf = downloadNutritionPdf;
  async function saveFile(name, bytes, type) {
    if (window.__eklniSaveFile) return window.__eklniSaveFile(name, bytes);
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return 'saved';
  }

  // Share the plan as a read-only link (e-mail / WhatsApp / Telegram). The link is created only after consent.
  async function showShare(box) {
    let links = [];
    try { links = (await api('GET', '/api/share')).links; } catch { /* list is optional */ }
    box.innerHTML = '';
    const out = h('div', {});
    const days = h('select', { 'aria-label': 'مدة الرابط' }, [[1, 'يوم واحد'], [7, '7 أيام'], [30, '30 يوم']].map(([v, t]) => h('option', { value: String(v), selected: v === 7 ? 'selected' : null }, t)));
    const showName = h('input', { type: 'checkbox' });
    const ok = h('input', { type: 'checkbox' });
    const btn = (href, label) => h('a', { class: 'btn', href, target: '_blank', rel: 'noopener noreferrer' }, label);
    const create = async () => {
      if (!ok.checked) { toast('علّم على الموافقة الأول'); return; }
      try {
        const r = await api('POST', '/api/share', { days: Number(days.value), confirm: true, showName: showName.checked });
        out.innerHTML = '';
        const url = h('input', { type: 'text', readonly: 'readonly', value: r.url, dir: 'ltr', 'aria-label': 'الرابط' });
        put(out, h('div', { class: 'notice info' }, h('strong', {}, `الرابط جاهز وصالح لحد ${dateAr(r.expiresAt.slice(0, 10))}`), url,
          h('div', { class: 'actions' },
            btn(r.whatsapp, 'واتس اب'), btn(r.telegram, 'تليجرام'), h('a', { class: 'btn', href: r.email }, 'إيميل'),
            h('button', { type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(r.url); toast('اتنسخ'); } catch { url.select(); } } }, 'نسخ الرابط'),
            navigator.share ? h('button', { type: 'button', onclick: () => navigator.share({ title: 'خطة التغذية — أكلني | Eklni', text: r.text, url: r.url }).catch(() => {}) }, 'مشاركة…') : null)));
      } catch (e) { if (e.status !== 402) toast(e.message); }
    };
    put(box, h('div', { class: 'card' }, h('h2', {}, 'شارك خطة التغذية'),
      h('p', { class: 'small' }, 'هنعمل رابط للقراءة بس فيه نسخة من خطة الأسبوع الحالية (الأهداف والوجبات والسوائل). أي حد معاه الرابط هيقدر يفتحه من غير حساب، فابعته للي تثق فيه بس (مدربك، أخصائيك، أهلك).'),
      h('ul', { class: 'small muted' }, h('li', {}, 'مش بيظهر في الرابط: إيميلك، إجابات الفحص الصحي، توافر الطاقة، ومعدل تعرقك.'),
        h('li', {}, 'الرابط نسخة ثابتة؛ لو عدّلت خطتك اعمل رابط جديد.'), h('li', {}, 'تقدر تلغيه في أي وقت، وبيقف لو اشتراكك خلص أو مسحت حسابك.')),
      h('label', {}, 'مدة الرابط ', days),
      h('label', { class: 'check' }, showName, ' اظهر اسمي في الملف'),
      h('label', { class: 'check' }, ok, ' فاهم إن أي حد معاه الرابط هيشوف الخطة'),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', onclick: create }, 'اعمل الرابط'), h('button', { type: 'button', onclick: () => drawWeek(box) }, 'رجوع')),
      out),
      links.length ? h('div', { class: 'card' }, h('h3', {}, 'الروابط اللي عملتها'), h('ul', { class: 'versions' }, links.map((l) => h('li', { class: 'spread' },
        h('span', {}, `${dateAr(l.createdAt.slice(0, 10))} · لحد ${dateAr(l.expiresAt.slice(0, 10))} · اتفتح ${l.views} مرة`),
        l.active ? h('button', { type: 'button', onclick: async () => { await api('DELETE', `/api/share/${l.id}`); toast('الرابط اتلغى'); showShare(box); } }, 'الغاء') : h('span', { class: 'badge' }, l.revokedAt ? 'ملغي' : 'منتهي'))))) : null);
  }

  async function showHistory(box) {
    const r = await api('GET', '/api/weekplan/history');
    box.innerHTML = '';
    put(box, h('div', { class: 'card' }, h('h2', {}, 'النسخ السابقة من خطة الأسبوع'),
      h('p', { class: 'small muted' }, 'كل تعديل بيتحفظ كنسخة (آخر 30 نسخة). الرجوع لنسخة قديمة بيعمل نسخة جديدة منها، ومفيش حاجة بتتمسح.'),
      h('ul', { class: 'versions' }, r.versions.map((v, i) => h('li', { class: 'spread' },
        h('span', {}, `${dateAr(v.createdAt.slice(0, 10))} ${v.createdAt.slice(11, 16)} — ${REASON_AR[v.reason] || (v.reason.startsWith('restored') ? 'استرجاع نسخة' : v.reason)}${v.avgKcal ? ` · ${v.avgKcal} سعرة/يوم` : ''}`),
        i === 0 ? h('span', { class: 'badge' }, 'الحالية') : h('button', { type: 'button', onclick: async () => { S.wp = await api('POST', `/api/weekplan/restore/${v.id}`); toast('رجعنا للنسخة دي'); drawWeek(box); } }, 'استرجاع')))),
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => drawWeek(box) }, 'رجوع'))));
  }

  const put = (box, ...k) => box.append(...k.flat(Infinity).filter((x) => x != null && x !== false));
  // ---------- health: screening, hydration, reference values, sources ----------
  function holdBanner(hold) {
    if (!hold || !hold.hold) return null;
    const items = hold.flags.filter((f) => f.level !== 'info').map((f) => f.text);
    return h('div', { class: 'notice bad', role: 'alert' }, h('strong', {}, isGainGoal(S.st?.goal?.input?.primaryGoal) ? 'الخطة على سعرات الثبات (من غير فائض) لحد ما الفحص يتعمل أو مختص يراجع' : 'الخطة على سعرات الثبات (من غير عجز) لحد مراجعة مختص'),
      h('ul', {}, items.map((x) => h('li', {}, x))), hold.referral ? h('p', { class: 'small' }, hold.referral) : null,
      hold.flags.some((f) => f.code === 'MINOR') ? guardianInviteBox() : null,
      hold.waiverAllowed ? waiverBox() : null,
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => { S.healthSub = 'screen'; go('health'); } }, 'الفحص الصحي')));
  }
  // One-week calorie override: the person picks a daily calorie average for up to 7 days, within the safety limits.
  function overrideCard() {
    const O = S.st.calorieOverride || {};
    const box = h('div', { class: 'card' });
    const after = (r, msg) => { S.st = r; if (r.planRefreshed) S.wp = null; toast(msg); go('nutrition'); };
    if (O.active) {
      put(box, h('h2', {}, 'سعرات مخصوصة'),
        h('p', {}, h('strong', {}, `${O.kcal} سعرة في اليوم`), ` لحد ${dateAr(O.endsOn)}. البروتين ثابت، والكربوهيدرات والدهون متظبطين على الرقم ده، وخطة الأسبوع اتعملت عليه.`),
        h('div', { class: 'actions' }, h('button', { type: 'button', onclick: async () => {
          try { after(await api('DELETE', '/api/calorie-override'), 'رجعت أهدافك العادية'); } catch (e) { toast(errMsg(e)); }
        } }, 'إلغاء والرجوع لأهدافي')));
      return box;
    }
    const kcal = h('input', { type: 'number', inputmode: 'numeric', min: O.min || 800, max: 6000, step: 10, placeholder: O.min ? `مثلًا ${O.min + 200}` : '', 'aria-label': 'السعرات في اليوم' });
    const days = h('select', { 'aria-label': 'المدة' }, [1, 2, 3, 4, 5, 6, 7].map((d) => h('option', { value: String(d), selected: d === 7 ? 'selected' : null }, d === 1 ? 'يوم واحد' : d === 2 ? 'يومين' : `${d} أيام`)));
    put(box, h('h2', {}, 'عايز سعرات معينة؟'),
      h('p', { class: 'small' }, 'اكتب عدد السعرات اللي عايزها في اليوم، والبرنامج هيظبط الخطة عليها لمدة أقصاها أسبوع، وبعدها بيرجع لأهدافك المحسوبة.'),
      h('p', { class: 'small muted' }, `أقل رقم مسموح ليك: ${O.min || '—'} سعرة (حدود الأمان). البروتين مش بيقل.`),
      h('div', { class: 'row' }, h('div', {}, h('label', {}, 'السعرات في اليوم'), kcal), h('div', {}, h('label', {}, 'لمدة'), days)),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', onclick: async () => {
        try { after(await api('PUT', '/api/calorie-override', { kcal: Math.round(Number(kcal.value)), days: Number(days.value) }), 'الخطة اتظبطت على السعرات اللي اخترتها'); }
        catch (e) { if (e.status !== 402) toast(errMsg(e)); }
      } }, 'طبّق')));
    return box;
  }

  // Adult self-responsibility (owner decision 0.7.0): all three acknowledgements, withdrawable any time.
  function waiverBox() {
    const boxes = [['adult', 'عندي 18 سنة أو أكتر'], ['understood', 'فاهم إن التطبيق مش بيشخّص، وإن العلامات اللي فوق (أو عدم عمل الفحص) ممكن تكون محتاجة مختص'], ['responsibility', 'أتحمل مسؤولية تطبيق خطة فيها عجز سعرات']]
      .map(([k, t]) => ({ k, input: h('input', { type: 'checkbox' }), t }));
    return h('details', { class: 'card waiver' }, h('summary', {}, 'أكمّل على مسؤوليتي الشخصية'),
      h('p', { class: 'small' }, 'الخطة هتبقى فيها عجز سعرات، بس الحدود الآمنة هتفضل شغالة (أقصى عجز، وتوافر طاقة 30 على الأقل، وحدود معدل النزول). ده مش متاح لأقل من 18 سنة، ولا مع التقيؤ أو الملينات، ولا مع الحمل أو الرضاعة. تقدر تلغي الموافقة في أي وقت.'),
      boxes.map((b) => h('label', { class: 'check' }, b.input, ' ', b.t)),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', onclick: async () => {
        if (!boxes.every((b) => b.input.checked)) { toast('علّم على كل الإقرارات الأول'); return; }
        try { S.st = await api('PUT', '/api/self-waiver', Object.fromEntries(boxes.map((b) => [b.k, true]))); if (S.st.planRefreshed) S.wp = null; toast(S.st.planRefreshed ? 'الخطة اتحسبت بعجز على مسؤوليتك، واتعملت خطة الأسبوع من جديد' : 'الخطة اتحسبت بعجز على مسؤوليتك'); go('dashboard'); }
        catch (e) { if (e.status !== 402) toast(errMsg(e)); }
      } }, 'كمّل على مسؤوليتي')));
  }
  function waiverNotice(hold) {
    if (!hold || !hold.waiver) return null;
    return h('div', { class: 'notice warn' }, h('strong', {}, 'الخطة على مسؤوليتك الشخصية'),
      h('p', { class: 'small' }, hold.completed ? 'فيه علامات في الفحص الصحي، والأفضل تراجع مختص.' : 'الفحص الصحي ما اتعملش؛ الأفضل تكمّله من «صحتي».'),
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: async () => {
        try { S.st = await api('PUT', '/api/self-waiver', { accept: false }); if (S.st.planRefreshed) S.wp = null; toast('رجعنا لسعرات الثبات'); go('dashboard'); } catch (e) { toast(errMsg(e)); }
      } }, 'إلغاء الموافقة والرجوع للثبات')));
  }
  function guardianInviteBox() {
    const out = h('div', {});
    return h('div', { class: 'card' }, h('strong', {}, 'ابعت كود لولي أمرك'),
      h('p', { class: 'small' }, 'ولي الأمر يعمل حساب ويدخل الكود من «الأكاديمية والفريق ← انضم بكود»، وبعدين يقدر يوافق على الخطة أو يرفض. الكود بيشتغل مرة واحدة خلال 7 أيام.'),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', onclick: async () => {
        try { const r = await api('POST', '/api/family/invite', {}); out.innerHTML = ''; out.append(h('p', { class: 'invite-code', dir: 'ltr' }, r.code)); }
        catch (ex) { toast(errMsg(ex)); }
      } }, 'اعمل كود لولي الأمر')), out);
  }
  function renderHealth() {
    S.healthSub = S.healthSub || 'screen';
    const subs = [['screen', 'الفحص الصحي'], ['hydration', 'السوائل والعرق'], ['dri', 'الفيتامينات والمعادن'], ['refs', 'المصادر']];
    const box = h('div', {});
    append(h('h1', {}, 'صحتي'),
      h('div', { class: 'subtabs', role: 'tablist' }, subs.map(([k, l]) => h('button', { type: 'button', role: 'tab', class: S.healthSub === k ? 'active' : null, 'aria-selected': S.healthSub === k ? 'true' : 'false', onclick: () => { S.healthSub = k; go('health'); } }, l))),
      box);
    ({ screen: drawScreening, hydration: drawHydration, dri: drawDri, refs: drawRefs }[S.healthSub])(box).catch(() => { box.textContent = 'تعذر التحميل.'; });
  }

  const EAT_Q = { preoccupied: 'التفكير في الأكل أو الوزن شاغل بالي معظم الوقت', compensate: 'بقلل الأكل أو بتمرن زيادة علشان أعوض أكل أكلته', purge: 'استخدمت تقيؤ أو ملينات أو مدرات بول للتحكم في وزني', loss_of_control: 'بحس إني مش قادر أوقف أكل في بعض المرات' };
  const MEN_AR = { regular: 'منتظمة', irregular: 'غير منتظمة (بتتأخر أو بتقل)', absent: 'منقطعة 3 شهور أو أكتر', hormonal_contraception: 'باستخدم وسيلة منع حمل هرمونية', not_sure: 'مش متابعة / مش متأكدة' };
  const IMP_AR = { none: 'لا', sci: 'إصابة نخاع شوكي', amputation: 'بتر', cp_abi: 'شلل دماغي / إصابة دماغية', visual: 'إعاقة بصرية', other: 'أخرى' };
  async function drawScreening(box) {
    const r = await api('GET', '/api/screening');
    const a = r.answers || { eating: [], conditions: [], impairment: 'none' };
    const v = { ...a, eating: [...(a.eating || [])], conditions: [...(a.conditions || [])] };
    const female = S.st?.goal?.input?.sex === 'female';
    const chk = (k, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: v[k], onchange: (e) => { v[k] = e.target.checked; } }), label);
    const multi = (k, key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: v[k].includes(key), onchange: (e) => { v[k] = e.target.checked ? [...v[k], key] : v[k].filter((x) => x !== key); } }), label);
    const res = r.result;
    put(box, 
      res.flags.length ? h('div', { class: 'card' }, h('h2', {}, res.hold ? 'النتيجة: الخطة على الثبات' : 'النتيجة: مسموح بخطة عجز'),
        h('ul', { class: 'flags' }, res.flags.map((f) => h('li', { class: `flag ${f.level}` }, f.text))),
        res.referral ? h('p', { class: 'small' }, h('strong', {}, res.referral)) : null) : null,
      h('form', { class: 'card', onsubmit: async (e) => {
        e.preventDefault();
        try { const sr = await api('PUT', '/api/screening', v); S.st = await api('GET', '/api/state'); if (sr.planRefreshed) S.wp = null; toast(sr.planRefreshed ? 'اتحفظ الفحص، واتعملت خطة الأسبوع من جديد بالسعرات الجديدة' : 'اتحفظ الفحص'); go('health'); }
        catch (ex) { toast(Object.values(ex.data?.errors || {})[0] || 'تعذر الحفظ'); }
      } },
        h('h2', {}, 'الفحص الصحي المبدئي'),
        h('p', { class: 'small muted' }, 'الأسئلة دي مش تشخيص. الهدف إننا نعرف إمتى لازم نوقف أي عجز سعرات ونرشحلك تراجع مختص. الإجابات بتتحفظ في حسابك بس ومش بتتبعت لأي جهة.'),
        female ? [h('label', {}, 'الدورة الشهرية آخر 3 شهور'), h('select', { onchange: (e) => { v.menstrual = e.target.value; } }, h('option', { value: '' }, 'اختاري'), Object.entries(MEN_AR).map(([k, l]) => h('option', { value: k, selected: v.menstrual === k || null }, l)))] : null,
        h('h3', {}, 'الأكل والوزن'), Object.entries(EAT_Q).map(([k, l]) => multi('eating', k, l)),
        h('h3', {}, 'الصحة والأداء'),
        chk('boneStressInjury', 'كسر إجهادي أو إصابة عظام آخر 12 شهر'), chk('recurrentIllness', 'دور برد/عدوى متكررة'), chk('persistentFatigue', 'إرهاق مستمر حتى مع الراحة'),
        chk('performanceDrop', 'الأداء بيقل من غير سبب واضح'), chk('unintendedWeightLoss', 'نزلت وزن من غير ما أقصد'),
        h('h3', {}, 'حالات صحية'), r.options.conditions.map((k) => multi('conditions', k, r.options.conditionsAr[k])),
        chk('medications', 'باخد أدوية بانتظام'), chk('supplements', 'باخد مكملات غذائية'),
        female ? chk('pregnantOrBreastfeeding', 'حامل أو بترضع') : null,
        h('label', {}, 'إعاقة حركية أو حسية؟'), h('select', { onchange: (e) => { v.impairment = e.target.value; } }, Object.entries(IMP_AR).map(([k, l]) => h('option', { value: k, selected: v.impairment === k || null }, l))),
        h('h3', {}, 'المتابعة'),
        chk('professionalClearance', 'مختص (طبيب/أخصائي تغذية رياضية) راجع حالتي ووافق على خطة خسارة وزن'),
        chk('consent', 'موافق على حفظ إجاباتي الصحية في حسابي لاستخدامها في حساب الخطة'),
        h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'primary' }, 'حفظ الفحص'))));
  }

  async function drawHydration(box) {
    const r = await api('GET', '/api/hydration');
    const f = { date: S.meta.today, environment: 'pool_indoor' };
    const inp = (k, label, attrs = {}) => [h('label', {}, label), h('input', { type: 'number', step: '0.1', inputmode: 'decimal', ...attrs, onchange: (e) => { f[k] = e.target.value; } })];
    const wut = { weightDown: false, urineDark: false, thirsty: false };
    const wutOut = h('p', { class: 'small' });
    const last = r.logs[r.logs.length - 1];
    put(box, 
      h('div', { class: 'card' }, h('h2', {}, 'معدل التعرق'),
        h('p', { class: 'small muted' }, 'السباح بيعرق في المية من غير ما يحس. اوزن نفسك بهدوم خفيفة ناشفة قبل الحصة وبعدها (بعد ما تنشف)، وسجل اللي شربته.'),
        r.summary ? h('div', { class: 'kpis' }, kpi('متوسط معدل التعرق', num(r.summary.avgSweatRateLph, 2), 'لتر/ساعة', `آخر ${r.summary.basedOnLast} حصص`), kpi('أقل / أعلى', `${r.summary.minLph} – ${r.summary.maxLph}`, 'لتر/ساعة')) : null,
        last ? h('div', {}, h('h3', {}, `آخر حصة (${dateAr(last.date)})`),
          h('p', {}, `العرق ${last.result.sweatLossL} لتر · ${last.result.sweatRateLph} لتر/ساعة · تغير الوزن ${last.result.bodyMassChangePct}%${last.result.replacedPct != null ? ` · عوّضت ${last.result.replacedPct}%` : ''}`),
          last.result.flags.length ? h('ul', { class: 'flags' }, last.result.flags.map((x) => h('li', { class: `flag ${x.level === 'warn' ? 'amber' : 'info'}` }, x.text))) : null,
          h('ul', {}, last.result.advice.map((x) => h('li', {}, x)))) : null),
      h('form', { class: 'card', onsubmit: async (e) => {
        e.preventDefault();
        try { await api('POST', '/api/hydration', f); toast('اتسجلت الحصة'); go('health'); }
        catch (ex) { toast(Object.values(ex.data?.errors || {})[0] || 'تعذر الحفظ'); }
      } }, h('h2', {}, 'سجّل حصة'),
        h('label', {}, 'التاريخ'), h('input', { type: 'date', value: f.date, onchange: (e) => { f.date = e.target.value; } }),
        inp('preKg', 'الوزن قبل الحصة (كجم)', { required: true }), inp('postKg', 'الوزن بعد الحصة (كجم)', { required: true }),
        inp('durationMin', 'مدة الحصة (دقيقة)', { step: '1', required: true }), inp('fluidL', 'شربت قد إيه أثناءها (لتر)'), inp('urineL', 'بول أثناء الحصة (لتر، لو معروف)'),
        h('label', {}, 'المكان'), h('select', { onchange: (e) => { f.environment = e.target.value; } },
          [['pool_indoor', 'حمام مغطى'], ['pool_outdoor', 'حمام مكشوف'], ['open_water', 'مياه مفتوحة'], ['land_hot', 'تمرين أرضي في الحر'], ['land_mild', 'تمرين أرضي في جو معتدل']].map(([k, l]) => h('option', { value: k }, l))),
        h('p', { class: 'small muted' }, 'الحساب: (الوزن قبل − بعد + اللي شربته − البول) ÷ الساعات، على أساس إن 1 كجم ≈ 1 لتر.'),
        h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'primary' }, 'احسب واحفظ'))),
      h('div', { class: 'card' }, h('h2', {}, 'فحص الصبح السريع'),
        h('p', { class: 'small muted' }, 'وزن أقل من المعتاد + لون بول غامق + عطش: مؤشرين = جفاف مرجّح، التلاتة = مرجّح جدًا.'),
        [['weightDown', 'وزني الصبح أقل من المعتاد'], ['urineDark', 'لون البول غامق'], ['thirsty', 'عطشان']].map(([k, l]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: async (e) => { wut[k] = e.target.checked; wutOut.textContent = (await api('POST', '/api/hydration/check', wut)).text; } }), l)),
        wutOut),
      r.logs.length ? h('div', { class: 'card' }, h('h2', {}, 'السجل'), h('ul', { class: 'versions' }, [...r.logs].reverse().map((s) => h('li', { class: 'spread' },
        h('span', {}, `${dateAr(s.date)} · ${s.durationMin} د · ${s.result.sweatRateLph} لتر/س · ${s.result.bodyMassChangePct}%`),
        h('button', { type: 'button', class: 'danger', onclick: async () => { await api('DELETE', `/api/hydration/${s.id}`); go('health'); } }, 'حذف'))))) : null);
  }

  async function drawDri(box) {
    const r = await api('GET', '/api/dri');
    const d = r.dri;
    if (!d) { put(box, notice('info', 'حدد العمر والجنس في الهدف الأول.')); return; }
    const row = (k) => h('tr', {}, h('th', {}, d[k].label), h('td', {}, d[k].rda), h('td', {}, d[k].ul ?? '—'));
    put(box, h('div', { class: 'card' }, h('h2', {}, 'الاحتياج اليومي المرجعي'),
      h('p', { class: 'small muted' }, `حسب العمر (${S.st.goal.input.age}) والجنس. ده للأصحاء، مش علاج لنقص.`),
      h('table', { class: 'table' }, h('tr', {}, h('th', {}, ''), h('th', {}, 'المطلوب يوميًا (RDA)'), h('th', {}, 'الحد الأعلى الآمن (UL)')), row('ironMg'), row('calciumMg'), row('vitDIU')),
      h('p', { class: 'small muted' }, `فيتامين د: ${d.vitDIU.rdaUg} ميكروجرام = ${d.vitDIU.rda} وحدة دولية.`),
      notice('warn', 'لو عندك نقص حديد أو فيتامين د متشخص، الجرعة بيحددها الطبيب. الحد الأعلى بيشمل الأكل والمكملات مع بعض، وما ينفعش تتعداه من غير إشراف طبي.'),
      h('p', { class: 'small muted' }, 'المصدر: RDA من الإرشادات الغذائية الأمريكية 2015–2020 (ملحق 7، جدول A7-1)، والحد الأعلى من Advanced Nutrition and Human Metabolism ط8 (جداول UL).')));
  }

  async function drawRefs(box) {
    const r = await api('GET', '/api/references');
    const q = r.foodQuality;
    put(box, 
      h('div', { class: 'card' }, h('h2', {}, 'جودة بيانات الأطعمة'),
        h('p', {}, `${q.foods} صنف · اتراجع منهم ${q.reviewed} · تقديري (proxy) ${q.proxies}`),
        h('p', { class: 'small' }, `تغطية القيم: حديد ${q.fieldCoverage.ironMg}% · فيتامين د ${q.fieldCoverage.vitDug}% · كالسيوم ${q.fieldCoverage.calciumMg}% · ألياف ${q.fieldCoverage.fiber}%`),
        notice('warn', 'القيم الغذائية لسه محتاجة مراجعة أخصائي تغذية مقابل جداول رسمية قبل أي استخدام علاجي أو بحثي.')),
      h('div', { class: 'card' }, h('h2', {}, 'المراجع'), h('p', { class: 'small muted' }, r._meta.note),
        r.references.map((x) => h('details', {}, h('summary', {}, `${x.title}${x.year ? ` (${x.year})` : ''}`),
          h('p', { class: 'small' }, `${x.authors} · ${x.publisher}${x.isbn ? ` · ISBN ${x.isbn}` : ''}`),
          x.usedFor.length ? h('ul', { class: 'small' }, x.usedFor.map((u) => h('li', {}, h('strong', {}, u.location), ' — ', u.detail))) : h('p', { class: 'small muted' }, x.note || 'مرجع عام؛ لم يُستخدم منه رقم مباشر في الحسابات.')))),
      h('div', { class: 'card' }, h('h2', {}, 'قواعد خاصة بالتطبيق (مش من مرجع)'), h('ul', { class: 'small' }, r.appRules.items.map((x) => h('li', {}, x)))));
  }

  // ---------- academy & team ----------
  const ROLE_AR = { admin: 'مدير', coach: 'مدرب', dietitian: 'أخصائي تغذية', athlete: 'لاعب', parent: 'ولي أمر' };
  const SPORT_AR = (k) => (S.meta.sports.find((x) => x.key === k) || {}).ar || k || '—';
  const DISC_AR = { sprint: 'سرعات', middle: 'مسافات متوسطة', distance: 'مسافات طويلة', open_water: 'مياه مفتوحة', mono: 'زعانف «مونو»', bi_fins: 'زعانف مزدوجة', apnea: 'غطس', foil: 'شيش', epee: 'سيف مبارزة', sabre: 'سيبر', sprint_tri: 'سبرنت', olympic: 'أولمبي', half: '70.3', full: 'آيرونمان' };
  const errMsg = (ex) => ex.data?.message || Object.values(ex.data?.errors || {})[0] || 'تعذر التنفيذ';

  async function renderTeam() {
    const box = h('div', {});
    append(h('div', { class: 'spread' }, h('h1', {}, 'الأكاديمية والفريق'),
      S.st?.goal ? h('button', { type: 'button', onclick: () => go('more') }, 'رجوع') : h('button', { type: 'button', onclick: () => startWizard() }, 'ابدأ هدف لنفسي')), box);
    if (S.teamView) { const v = S.teamView; S.teamView = null; return v(box); }
    const r = await api('GET', '/api/academies');
    const joinCode = h('input', { placeholder: 'XXXXX-XXXXX', dir: 'ltr', autocomplete: 'off', 'aria-label': 'كود الدعوة' });
    const joinName = h('input', { placeholder: 'الاسم اللي يظهر للأكاديمية', 'aria-label': 'الاسم' });
    const newName = h('input', { placeholder: 'اسم الأكاديمية', 'aria-label': 'اسم الأكاديمية' });
    const myName = h('input', { placeholder: 'اسمك في الأكاديمية', 'aria-label': 'اسمك' });
    put(box,
      r.academies.map((a) => academyCard(a)),
      !r.academies.length ? h('p', { class: 'muted' }, 'مش عضو في أي أكاديمية لسه.') : null,
      h('form', { class: 'card', onsubmit: async (e) => { e.preventDefault();
        try { await api('POST', '/api/invites/accept', { code: joinCode.value, displayName: joinName.value }); toast('انضميت للأكاديمية'); go('team'); } catch (ex) { toast(errMsg(ex)); } } },
        h('h2', {}, 'انضم بكود دعوة'), h('label', {}, 'الكود'), joinCode, h('label', {}, 'اسمك'), joinName,
        h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'primary' }, 'انضمام'))),
      h('form', { class: 'card', onsubmit: async (e) => { e.preventDefault();
        try { await api('POST', '/api/academies', { name: newName.value, displayName: myName.value }); toast('اتعملت الأكاديمية'); go('team'); } catch (ex) { toast(errMsg(ex)); } } },
        h('h2', {}, 'أنشئ أكاديمية'), h('p', { class: 'small muted' }, 'هتبقى مدير الأكاديمية، وتقدر تدعو مدربين وأخصائيين ولاعبين وأولياء أمور.'),
        h('label', {}, 'اسم الأكاديمية'), newName, h('label', {}, 'اسمك'), myName,
        h('div', { class: 'actions' }, h('button', { type: 'submit' }, 'إنشاء'))),
      h('div', { class: 'card' }, h('h2', {}, 'مين بيشوف إيه؟'), h('ul', { class: 'small' },
        h('li', {}, 'المدرب: الرياضة والتخصص والحصص، والأداء والنوم والطاقة والالتزام، ومتوسط العرق، و«يحتاج مراجعة» (نعم/لا) — من غير وزن ولا سعرات ولا فحص.'),
        h('li', {}, 'أخصائي التغذية: نفس عرض المدرب، والبيانات الصحية كاملة فقط لو اللاعب وافق (أو ولي الأمر لو اللاعب أقل من 18 سنة).'),
        h('li', {}, 'ولي الأمر: ابنه/بنته بس — الأهداف وسبب توقف الخطة، من غير إجابات الفحص ولا الأوزان.'),
        h('li', {}, 'المدير: الأسماء والأدوار بس، وسجل مين شاف إيه.'))));
  }

  function academyCard(a) {
    const isAthlete = a.roles.includes('athlete');
    const ctl = a.sharingControl;
    return h('div', { class: 'card' },
      h('div', { class: 'spread' }, h('h2', {}, a.name), h('span', { class: 'item-tags' }, a.roles.map((r) => h('span', { class: 'badge' }, ROLE_AR[r])))),
      isAthlete ? h('div', {},
        h('p', { class: 'small' }, a.sharing.shareHealth ? 'بياناتك الصحية متشاركة مع أخصائي التغذية في الأكاديمية.' : 'بياناتك الصحية مش متشاركة؛ المدرب والأخصائي شايفين التمرين والأداء بس.'),
        ctl.by === 'athlete' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: a.sharing.shareHealth, onchange: async (e) => {
          try { await api('PUT', `/api/academies/${a.id}/sharing`, { shareHealth: e.target.checked }); toast('اتحفظ'); go('team'); } catch (ex) { toast(errMsg(ex)); go('team'); } } }),
          'أوافق إن أخصائي التغذية يشوف بياناتي الصحية (الوزن، الأهداف، الفحص، العرق)') : h('p', { class: 'small muted' }, ctl.reason)) : null,
      (a.children || []).map((c) => h('div', { class: 'child' }, h('strong', {}, c.displayName),
        c.sharingControl.by === 'guardian' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.sharing.shareHealth, onchange: async (e) => {
          try { await api('PUT', `/api/academies/${a.id}/sharing`, { athleteId: c.userId, shareHealth: e.target.checked }); toast('اتحفظ'); go('team'); } catch (ex) { toast(errMsg(ex)); go('team'); } } }),
          'أوافق إن أخصائي التغذية يشوف البيانات الصحية لابني/بنتي') : h('p', { class: 'small muted' }, c.sharingControl.reason || 'اللاعب فوق 18 سنة وهو اللي يقرر.'),
        c.minorConsent ? minorConsentBox(a, c) : null)),
      h('div', { class: 'actions' },
        a.isStaff || a.roles.includes('parent') ? h('button', { type: 'button', class: 'primary', onclick: () => { S.teamView = (b) => drawRoster(b, a); go('team'); } }, a.isStaff ? 'اللاعبين' : 'ابني/بنتي') : null,
        a.canInvite.length ? h('button', { type: 'button', onclick: () => { S.teamView = (b) => drawInvite(b, a); go('team'); } }, 'دعوة') : null,
        a.roles.includes('admin') ? h('button', { type: 'button', onclick: () => { S.teamView = (b) => drawMembers(b, a); go('team'); } }, 'الأعضاء والسجل') : null,
        a.roles.includes('admin') ? h('button', { type: 'button', onclick: () => { S.teamView = (b) => drawBranding(b, a); go('team'); } }, 'الشعار والتوقيع') : null));
  }

  const SCR_AR = { menstrual: 'الدورة', eating: 'الأكل والوزن', boneStressInjury: 'إصابة عظام', recurrentIllness: 'عدوى متكررة', persistentFatigue: 'إرهاق مستمر',
    performanceDrop: 'هبوط الأداء', unintendedWeightLoss: 'نزول وزن غير مقصود', conditions: 'حالات صحية', medications: 'أدوية', supplements: 'مكملات',
    impairment: 'إعاقة', pregnantOrBreastfeeding: 'حمل/رضاعة', professionalClearance: 'موافقة مختص' };
  function minorConsentBox(a, c) {
    const ok = h('input', { type: 'checkbox' });
    if (c.minorConsent.active) {
      return h('div', { class: 'notice warn' }, h('strong', {}, `انت موافق على خطة خسارة وزن لـ ${c.displayName} من ${dateAr(c.minorConsent.grantedAt.slice(0, 10))}.`),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'danger', onclick: async () => {
          try { await api('PUT', `/api/academies/${a.id}/minor-consent`, { athleteId: c.userId, allowWeightLoss: false }); toast('اتلغت الموافقة'); go('team'); } catch (ex) { toast(errMsg(ex)); }
        } }, 'إلغاء الموافقة')));
    }
    return h('div', { class: 'notice info' }, h('strong', {}, 'خطة خسارة وزن لابنك/بنتك؟'),
      h('ul', { class: 'small' },
        h('li', {}, 'النمو والأداء أهم من الوزن في السن ده؛ التطبيق بيحدد العجز بـ 15% بس، والمعدل بنص في المية من الوزن في الأسبوع.'),
        h('li', {}, 'لو فيه أي علامة صحية حمراء (زي مشاكل الأكل أو كسور الإجهاد) الخطة هتفضل على الثبات حتى مع موافقتك.'),
        h('li', {}, 'يُنصح جدًا بمتابعة أخصائي تغذية رياضية، وتقدر تلغي الموافقة في أي وقت.')),
      h('label', { class: 'check' }, ok, 'قريت التنبيه وموافق على خطة خسارة وزن تحت المتابعة'),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', onclick: async () => {
        try { await api('PUT', `/api/academies/${a.id}/minor-consent`, { athleteId: c.userId, allowWeightLoss: true, understood: ok.checked }); toast('اتسجلت الموافقة'); go('team'); } catch (ex) { toast(errMsg(ex)); }
      } }, 'موافق')));
  }
  const back = () => h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => go('team') }, 'رجوع للأكاديميات'));
  const scoreRow = (w) => w ? `أداء ${w.performance ?? '—'} · طاقة ${w.energy ?? '—'} · نوم ${w.sleep ?? '—'} · تعافي ${w.recovery ?? '—'} · التزام ${w.adherencePct ?? '—'}%` : 'مفيش متابعة أسبوعية';

  async function drawRoster(box, a) {
    const r = await api('GET', `/api/academies/${a.id}/athletes`);
    put(box, h('h2', {}, `${a.name} — اللاعبين`),
      !r.athletes.length ? h('p', { class: 'muted' }, 'مفيش لاعبين لسه. ابعت كود دعوة.') : null,
      r.athletes.map((x) => h('button', { type: 'button', class: 'card athlete-row', onclick: () => { S.teamView = (b) => drawAthlete(b, a, x.userId); go('team'); } },
        h('div', { class: 'spread' }, h('strong', {}, x.displayName),
          x.needsReview ? h('span', { class: 'badge bad' }, 'يحتاج مراجعة') : x.hasGoal ? h('span', { class: 'badge' }, 'متابع') : h('span', { class: 'badge' }, 'بدون هدف')),
        h('div', { class: 'small muted' }, `${SPORT_AR(x.sport)}${x.swimDiscipline ? ` · ${DISC_AR[x.swimDiscipline]}` : ''}${x.avgSweatRateLph != null ? ` · عرق ${x.avgSweatRateLph} لتر/س` : ''}`),
        h('div', { class: 'small' }, scoreRow(x.lastWellness)),
        a.roles.includes('dietitian') ? h('div', { class: 'small muted' }, x.healthShared ? 'البيانات الصحية متشاركة' : 'البيانات الصحية مش متشاركة') : null)),
      back());
  }

  async function drawAthlete(box, a, id) {
    let v;
    try { v = await api('GET', `/api/academies/${a.id}/athletes/${id}`); } catch (ex) { put(box, notice('bad', errMsg(ex)), back()); return; }
    const t2 = v.targets;
    put(box, h('div', { class: 'card' }, h('div', { class: 'spread' }, h('h2', {}, v.displayName), h('span', { class: 'badge' }, v.levelAr)),
        v.hasGoal ? h('p', {}, `${SPORT_AR(v.sport)}${v.swimDiscipline ? ` · ${DISC_AR[v.swimDiscipline]}` : ''} · ${v.sessionsPerWeek} حصص × ${v.minutesPerSession} د${v.competitionDate ? ` · منافسة ${dateAr(v.competitionDate)}` : ''}`) : h('p', { class: 'muted' }, 'اللاعب لسه ما حددش هدف.'),
        v.needsReview ? notice('bad', 'الخطة على سعرات الثبات لحد مراجعة مختص.') : null,
        v.healthHidden ? notice('info', v.healthHidden) : null),
      v.wellness ? h('div', { class: 'card' }, h('h3', {}, 'آخر المتابعات'), v.wellness.length ? h('ul', { class: 'small' }, v.wellness.map((w) => h('li', {}, `أسبوع ${w.week}: ${scoreRow(w)}`))) : h('p', { class: 'muted small' }, 'مفيش.'),
        v.hydration ? h('p', { class: 'small' }, `متوسط معدل العرق ${v.hydration.avgSweatRateLph} لتر/ساعة (${v.hydration.sessions} حصص)`) : null) : null,
      v.holdFlags && v.holdFlags.length ? h('div', { class: 'card' }, h('h3', {}, 'علامات تحتاج متابعة'), h('ul', { class: 'flags' }, v.holdFlags.map((f) => h('li', { class: `flag ${f.level}` }, f.text))), v.referral ? h('p', { class: 'small' }, v.referral) : null) : null,
      t2 ? h('div', { class: 'card' }, h('h3', {}, 'الأهداف اليومية'), h('table', { class: 'table' }, h('tr', {}, h('th', {}, ''), h('th', {}, 'سعرات'), h('th', {}, 'بروتين'), h('th', {}, 'كربوهيدرات'), h('th', {}, 'دهون')),
        [['يوم تدريب', t2.trainingDay], ['يوم راحة', t2.restDay]].filter(([, d]) => d).map(([l, d]) => h('tr', {}, h('th', {}, l), h('td', {}, d.kcal), h('td', {}, d.proteinG), h('td', {}, d.carbG), h('td', {}, d.fatG)))),
        v.energyAvailability && v.energyAvailability.status ? h('p', { class: 'small' }, `توافر الطاقة ${v.energyAvailability.value} — ${v.energyAvailability.status.ar}`) : null) : null,
      v.weeks ? h('div', { class: 'card' }, h('h3', {}, 'المتوسطات الأسبوعية'), h('ul', { class: 'small' }, v.weeks.filter((w) => w.avgWeight != null).map((w) => h('li', {}, `أسبوع ${w.week}: ${w.avgWeight} كجم${w.waistCm ? ` · خصر ${w.waistCm}` : ''}`))),
        h('p', { class: 'small' }, `الهدف ${v.goal.targetWeight} كجم · ${v.goal.weeklyRateKg} كجم/أسبوع · الموعد التقديري ${dateAr(v.projection)}`)) : null,
      v.planReview ? reviewCard(box, a, id, v) : null,
      v.screening ? h('div', { class: 'card' }, h('h3', {}, 'إجابات الفحص الصحي'), h('p', { class: 'small muted' }, `آخر تحديث ${v.screening.updatedAt ? dateAr(v.screening.updatedAt.slice(0, 10)) : '—'}`),
        h('ul', { class: 'small' }, Object.entries(v.screening).filter(([k, x]) => !['consent', 'consentAt', 'updatedAt'].includes(k) && x && (!Array.isArray(x) || x.length) && x !== 'none').map(([k, x]) => h('li', {}, `${SCR_AR[k] || k}: ${Array.isArray(x) ? x.map((y) => EAT_Q[y] || (k === 'conditions' ? y : y)).join('، ') : x === true ? 'نعم' : MEN_AR[x] || IMP_AR[x] || x}`)))) : null,
      back());
  }

  // dietitian plan review (audit 2026-10-22): the server allows it only at the clinical level
  function reviewCard(box, a, id, v) {
    const pr = v.planReview;
    const note = h('textarea', { rows: 2, maxlength: 500, placeholder: 'ملاحظة (لازمة لطلب التعديل أو الرفض أو الإحالة)', 'aria-label': 'ملاحظة المراجعة' });
    const send = async (decision) => {
      try { await api('POST', `/api/academies/${a.id}/athletes/${id}/review`, { decision, note: note.value }); toast('اتسجلت المراجعة'); drawAthlete(box, a, id); }
      catch (ex) { toast(errMsg(ex)); }
    };
    return h('div', { class: 'card' }, h('h3', {}, 'مراجعة الخطة'),
      h('p', { class: pr.state === 'current' ? 'small' : 'small muted' }, pr.text),
      pr.note && pr.state !== 'none' ? h('p', { class: 'small' }, `ملاحظة: ${pr.note}`) : null,
      v.requiresProfessional ? notice('warn', 'الحساب طالع إن الخطة دي محتاجة مراجعة مختص.') : null,
      v.calcVersion ? h('p', { class: 'small muted' }, `إصدار الحسابات: ${v.calcVersion}`) : null,
      v.canReview ? [note, h('div', { class: 'actions wrap' },
        h('button', { type: 'button', class: 'primary', onclick: () => send('approved') }, 'موافقة'),
        h('button', { type: 'button', onclick: () => send('revision_requested') }, 'طلب تعديل'),
        h('button', { type: 'button', onclick: () => send('referred') }, 'إحالة لطبيب/مختص'),
        h('button', { type: 'button', class: 'danger', onclick: () => send('rejected') }, 'رفض'))] : null);
  }

  async function drawInvite(box, a) {
    let athletes = [];
    if (a.canInvite.includes('parent')) { try { athletes = (await api('GET', `/api/academies/${a.id}/athletes`)).athletes; } catch { /* ignore */ } }
    const f = { role: a.canInvite[0] };
    const out = h('div', {});
    const athleteSel = h('select', { onchange: (e) => { f.athleteId = Number(e.target.value); } }, h('option', { value: '' }, 'اختار اللاعب'), athletes.map((x) => h('option', { value: x.userId }, x.displayName)));
    const athleteWrap = h('div', { hidden: f.role !== 'parent' || null }, h('label', {}, 'ولي أمر مين؟'), athleteSel);
    put(box, h('form', { class: 'card', onsubmit: async (e) => { e.preventDefault();
      try {
        const r = await api('POST', `/api/academies/${a.id}/invites`, f);
        out.innerHTML = '';
        out.append(h('div', { class: 'notice info' }, h('strong', {}, `كود دعوة (${r.roleAr}):`), h('p', { class: 'invite-code', dir: 'ltr' }, r.code), h('p', { class: 'small' }, r.note)));
      } catch (ex) { toast(errMsg(ex)); } } },
      h('h2', {}, `دعوة لـ ${a.name}`),
      h('label', {}, 'الدور'), h('select', { onchange: (e) => { f.role = e.target.value; athleteWrap.hidden = f.role !== 'parent'; } }, a.canInvite.map((r) => h('option', { value: r }, ROLE_AR[r]))),
      athleteWrap,
      h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'primary' }, 'اعمل كود')), out), back());
  }

  async function drawBranding(box, a) {
    const r = await api('GET', `/api/academies/${a.id}/branding`);
    const b = { signature: r.branding.signature || '', logo: r.branding.logo || null };
    const prev = h('div', { class: 'logo-prev' });
    const showPrev = () => { prev.innerHTML = ''; if (b.logo) prev.append(h('img', { src: b.logo, alt: 'الشعار' })); };
    showPrev();
    const sig = h('input', { value: b.signature, placeholder: 'مثال: ك/ أحمد ربيع', maxlength: 60, oninput: (e) => { b.signature = e.target.value; } });
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', onchange: (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (f.size > 300 * 1024) { toast('الصورة أكبر من 300 كيلوبايت'); e.target.value = ''; return; }
      const rd = new FileReader();
      rd.onload = () => { b.logo = rd.result; showPrev(); };
      rd.readAsDataURL(f);
    } });
    put(box, h('form', { class: 'card', onsubmit: async (e) => { e.preventDefault();
      try { await api('PUT', `/api/academies/${a.id}/branding`, b); toast('اتحفظ'); } catch (ex) { toast(errMsg(ex)); } } },
      h('h2', {}, 'الشعار والتوقيع في الملفات'),
      h('p', { class: 'small muted' }, 'التوقيع بيظهر أسفل كل صفحة في ملف التغذية والتقرير، والشعار كعلامة مائية خفيفة في الخلفية — لكل أعضاء الأكاديمية.'),
      h('label', {}, 'التوقيع'), sig,
      h('label', {}, 'الشعار (PNG أو JPG أو WEBP، أقل من 300 كيلوبايت)'), file, prev,
      b.logo ? h('button', { type: 'button', class: 'ghost', onclick: () => { b.logo = null; showPrev(); } }, 'شيل الشعار') : null,
      h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'primary' }, 'حفظ'))), back());
  }

  async function drawMembers(box, a) {
    const [m, lg] = await Promise.all([api('GET', `/api/academies/${a.id}/members`), api('GET', `/api/academies/${a.id}/audit`)]);
    const ACT = { academy_create: 'إنشاء الأكاديمية', member_remove: 'إزالة عضو', member_leave: 'مغادرة', sharing_on: 'تفعيل مشاركة البيانات الصحية', sharing_off: 'إيقاف المشاركة', view_roster: 'عرض قائمة اللاعبين' };
    const actAr = (x) => ACT[x] || (x.startsWith('invite_create:') ? `كود دعوة (${ROLE_AR[x.split(':')[1]]})` : x.startsWith('member_join:') ? `انضمام (${ROLE_AR[x.split(':')[1]]})` : x.startsWith('view_athlete:') ? 'عرض لاعب' : x);
    put(box, h('div', { class: 'card' }, h('h2', {}, 'الأعضاء'), h('ul', { class: 'versions' }, m.members.map((x) => h('li', { class: 'spread' },
        h('span', {}, `${x.displayName} · ${x.rolesAr.join('، ')}${x.email ? ` · ${x.email}` : ''}`),
        h('button', { type: 'button', class: 'danger', onclick: async (e) => {
          if (e.target.dataset.armed !== '1') { e.target.dataset.armed = '1'; e.target.textContent = 'متأكد؟ اضغط تاني'; return; }
          try { await api('DELETE', `/api/academies/${a.id}/members/${x.userId}`, { confirm: true }); toast('اتشال'); S.teamView = (b) => drawMembers(b, a); go('team'); } catch (ex) { toast(errMsg(ex)); } } }, 'إزالة'))))),
      h('div', { class: 'card' }, h('h2', {}, 'سجل التدقيق'), h('p', { class: 'small muted' }, 'مين عمل إيه ومتى — من غير أي بيانات صحية.'),
        h('ul', { class: 'small' }, lg.log.slice(0, 60).map((e) => h('li', {}, `${e.at.slice(0, 16).replace('T', ' ')} — ${e.actor}: ${actAr(e.action)}${e.target ? ` ← ${e.target}` : ''}`)))),
      back());
  }

  // ---------- subscription ----------
  const SUB_AR = { trial: 'فترة تجريبية', active: 'مشترك', expired: 'منتهي', none: 'مفيش اشتراك', owner: 'مالك المنصة', canceled: 'ملغي' };
  function subCard() {
    const x = S.sub;
    if (!x) return null;
    return h('div', { class: 'card' }, h('div', { class: 'spread' }, h('h2', {}, 'الاشتراك'), h('span', { class: 'badge' }, SUB_AR[x.state] || x.state)),
      x.endsOn ? h('p', {}, `ساري لحد ${dateAr(x.endsOn)}${x.daysLeft != null ? ` (فاضل ${x.daysLeft} ${x.daysLeft === 1 ? 'يوم' : 'أيام'})` : ''}.`) : null,
      h('p', { class: 'small muted' }, 'الاشتراك شهري. لما يخلص كل الأدوات بتتقفل، وبياناتك بتفضل محفوظة وتقدر تنزّلها CSV في أي وقت.'),
      payInfo());
  }
  function payInfo() {
    const pr = S.pricing || {};
    return h('div', {}, pr.priceEgp ? h('p', {}, h('strong', {}, `${pr.priceEgp} جنيه / شهر`)) : null,
      pr.paymentNote ? h('p', { class: 'small' }, pr.paymentNote) : h('p', { class: 'small muted' }, 'للتجديد تواصل مع إدارة المنصة؛ بعد الدفع الاشتراك بيتفعّل من حسابهم.'));
  }
  const VER_AR = { none: 'مش مقدّم', pending: 'تحت المراجعة', verified: 'موثّق', rejected: 'مرفوض', revoked: 'اتلغى التوثيق' };
  function proCard() {
    const p = S.pro;
    if (!p) return null;
    const lic = h('input', { placeholder: 'رقم القيد / الترخيص', maxlength: 40 });
    const iss = h('input', { placeholder: 'الجهة (مثلًا: نقابة المهن الطبية / وزارة الصحة)', maxlength: 100 });
    return h('div', { class: 'card' }, h('div', { class: 'spread' }, h('h2', {}, 'حساب أخصائي التغذية'), h('span', { class: 'badge' }, VER_AR[p.verification] || p.verification)),
      h('p', { class: 'small muted' }, 'منفصل عن اشتراكك العادي: التوثيق + اشتراك الأخصائي هما اللي بيفتحوا عرض البيانات الصحية للاعبين اللي وافقوا. اشتراكك العادي بيفتح أدواتك الشخصية بس.'),
      p.subscription.endsOn ? h('p', {}, `اشتراك الأخصائي ${p.subscription.active ? `ساري لحد ${dateAr(p.subscription.endsOn)}` : 'منتهي'}.`) : null,
      p.decisionNote && p.verification !== 'verified' ? h('p', { class: 'small' }, p.decisionNote) : null,
      p.verification !== 'verified' ? h('form', { onsubmit: async (e) => { e.preventDefault();
        try { S.pro = await api('POST', '/api/pro/apply', { licenseNo: lic.value, issuer: iss.value }); toast('اتبعت الطلب للمراجعة'); go('more'); } catch (ex) { toast(errMsg(ex)); } } },
        h('label', {}, 'رقم القيد'), lic, h('label', {}, 'الجهة المصدرة'), iss,
        h('div', { class: 'actions' }, h('button', { type: 'submit' }, p.applied ? 'تحديث الطلب' : 'قدّم للتوثيق'))) : null);
  }
  function inboxCard() {
    const box = h('div', {});
    api('GET', '/api/inbox').then((r) => {
      const unread = r.items.filter((i) => !i.readAt);
      if (!unread.length) return;
      box.append(h('div', { class: 'card inbox' }, h('div', { class: 'spread' }, h('h2', {}, `التنبيهات (${unread.length})`),
        h('button', { type: 'button', class: 'ghost small-btn', onclick: async () => { await api('POST', '/api/inbox/read-all', {}); box.innerHTML = ''; } }, 'تم الكل')),
        h('ul', { class: 'versions' }, unread.slice(0, 5).map((i) => h('li', { class: 'spread' }, h('span', {}, h('strong', {}, i.title), ' — ', i.body),
          h('button', { type: 'button', class: 'chip', onclick: async (e) => { await api('POST', `/api/inbox/${i.id}/read`, {}); e.target.closest('li').remove(); } }, 'تم'))))));
    }).catch(() => {});
    return box;
  }
  // «البيت»: same dishes for people who live together; each person's grams stay his own.
  function householdCard() {
    const box = h('div', { class: 'card' }, h('h2', {}, 'البيت'), h('p', { class: 'small muted' }, 'جارٍ التحميل…'));
    const KIND_AR = { breakfast: 'الفطار', lunch: 'الغدا', dinner: 'العشا' };
    const draw = (H, extra = null) => {
      box.innerHTML = '';
      if (!H) {
        const name = h('input', { placeholder: 'اسم البيت (مثلًا: بيت العيلة)', maxlength: 40, 'aria-label': 'اسم البيت' });
        const me = h('input', { placeholder: 'اسمك في البيت', maxlength: 40, 'aria-label': 'اسمك' });
        const code = h('input', { placeholder: 'XXXXX-XXXXX', dir: 'ltr', 'aria-label': 'كود البيت' });
        put(box, h('h2', {}, 'البيت'),
          h('p', { class: 'small' }, 'لو عايش مع حد بيستخدم أكلني (أخوك، مراتك، أهلك)، اربطوا حساباتكم: الوجبات اللي تختاروها (الفطار مثلًا) هتطلع بنفس الطبق ونفس المكونات للكل، وكل واحد كميته بالجرام على حسب هدفه.'),
          h('p', { class: 'small muted' }, 'اللي بيتشارك: اسمك في البيت وأسماء الأطباق بس. مش بيظهر لحد وزنك ولا سعراتك ولا فحصك الصحي.'),
          h('label', {}, 'اسمك'), me, h('label', {}, 'اسم البيت'), name,
          h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', onclick: async () => {
            try { draw((await api('POST', '/api/household', { name: name.value, displayName: me.value })).household); toast('اتعمل البيت'); } catch (e) { if (e.status !== 402) toast(errMsg(e)); }
          } }, 'اعمل بيت جديد')),
          h('h3', {}, 'أو انضم لبيت بكود'), code,
          h('div', { class: 'actions' }, h('button', { type: 'button', onclick: async () => {
            try { draw((await api('POST', '/api/household/join', { code: code.value, displayName: me.value })).household); toast('انضميت للبيت'); } catch (e) { if (e.status !== 402) toast(errMsg(e)); }
          } }, 'انضم')));
        return;
      }
      const kinds = new Set(H.sharedMeals);
      put(box, h('h2', {}, `البيت: ${H.name}`),
        h('ul', { class: 'versions' }, H.members.map((m) => h('li', { class: 'spread' },
          h('span', {}, m.displayName, m.me ? ' (أنا)' : '', m.manager ? h('span', { class: 'badge' }, 'مسؤول البيت') : null, m.hasPlan ? null : h('span', { class: 'small muted' }, ' · لسه معملش خطة')),
          H.manager && !m.me ? h('button', { type: 'button', class: 'ghost small-btn', onclick: async () => { try { draw((await api('DELETE', `/api/household/members/${m.id}`)).household); } catch (e) { toast(errMsg(e)); } } }, 'شيل') : null))),
        h('p', { class: 'small' }, `الوجبات المشتركة: ${H.sharedMeals.map((k) => KIND_AR[k]).join('، ') || 'ولا وجبة'}`),
        H.manager ? h('div', { class: 'item-tags' }, Object.entries(KIND_AR).map(([k, ar]) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: kinds.has(k), onchange: (e) => { if (e.target.checked) kinds.add(k); else kinds.delete(k); } }), ar)),
          h('button', { type: 'button', onclick: async () => { try { draw((await api('PUT', '/api/household', { sharedMeals: [...kinds] })).household); toast('اتحفظ'); } catch (e) { toast(errMsg(e)); } } }, 'حفظ')) : null,
        h('p', { class: 'small muted' }, 'اللي يعمل خطته الأول بيحدد أكل البيت للأسبوع، والباقيين لما يعملوا «خطة جديدة» هتطلع وجباتهم المشتركة بنفس الأطباق. لو طبق مش مناسب لحساسية أو تفضيلات حد، بيتغير له هو بس.'),
        extra,
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'primary', onclick: async () => { try { const r = await api('POST', '/api/household/invite'); draw(H, notice('info', `كود البيت: ${r.code} — بيشتغل مرة واحدة خلال 7 أيام. ابعته للي عايش معاك وهو يدخله من «المزيد ← البيت».`)); } catch (e) { toast(errMsg(e)); } } }, 'كود لفرد جديد'),
          h('button', { type: 'button', onclick: async () => { try { S.wp = await api('POST', '/api/weekplan', {}); toast('اتعملت خطتك بأكل البيت'); S.nutSub = 'week'; go('nutrition'); } catch (e) { toast(errMsg(e)); } } }, 'وحّد خطتي مع البيت'),
          h('button', { type: 'button', onclick: async () => {
            try {
              const g = await api('GET', '/api/household/grocery');
              draw(H, groceryView({ grocery: g.grocery }, `مشتريات البيت (${g.people} من ${g.members} عندهم خطة)`));
            } catch (e) { toast(errMsg(e)); }
          } }, 'مشتريات البيت'),
          h('button', { type: 'button', class: 'ghost', onclick: async () => { await api('POST', '/api/household/leave'); draw(null); toast('خرجت من البيت'); } }, 'اخرج من البيت')));
    };
    api('GET', '/api/household').then((r) => draw(r.household)).catch(() => { box.textContent = 'تعذر التحميل.'; });
    return box;
  }
  function dataCard() {
    const pw = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'كلمة المرور' });
    const word = h('input', { dir: 'ltr', placeholder: 'DELETE', 'aria-label': 'كلمة التأكيد' });
    const form = h('form', { hidden: true, onsubmit: async (e) => {
      e.preventDefault();
      try { await api('DELETE', '/api/account', { password: pw.value, confirm: word.value.trim() }); S.me = null; S.st = null; toast('اتمسح الحساب'); renderAuth('register'); }
      catch (ex) { toast(errMsg(ex)); }
    } },
      notice('bad', 'الحذف نهائي: الأهداف والأوزان والفحص والخطط وكل حاجة هتتمسح فورًا ومش هترجع. نسخ الاحتياطي بتتمسح منها خلال مدة دورانها (شوف سياسة الخصوصية).'),
      h('label', {}, 'كلمة المرور'), pw, h('label', {}, 'اكتب DELETE للتأكيد'), word,
      h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'danger' }, 'احذف حسابي نهائيًا')));
    const npw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, maxlength: 200, 'aria-label': 'كلمة مرور جديدة' });
    const setPw = S.hasPassword ? null : h('form', { class: 'notice info', onsubmit: async (e) => {
      e.preventDefault();
      try { await api('POST', '/api/auth/set-password', { password: npw.value }); S.hasPassword = true; e.target.remove(); toast('اتحفظت كلمة المرور'); } catch (ex) { toast(errMsg(ex)); }
    } }, h('strong', {}, 'حسابك متسجل بجوجل'), h('p', { class: 'small' }, 'تقدر تعمل كلمة مرور كمان علشان تدخل بالإيميل (ومطلوبة لحذف الحساب).'),
      npw, h('div', { class: 'actions' }, h('button', { type: 'submit' }, 'احفظ كلمة المرور')));
    return h('div', { class: 'card' }, h('h2', {}, 'بياناتي'), setPw,
      h('p', { class: 'small muted' }, 'تقدر تنزّل كل بياناتك في أي وقت (حتى لو الاشتراك خلص)، أو تحذف حسابك.'),
      h('div', { class: 'actions' }, h('a', { class: 'btn', href: '/api/export.json', download: 'eklni-my-data.json' }, 'تنزيل كل بياناتي (JSON)'),
        h('button', { type: 'button', class: 'danger', onclick: () => { form.hidden = !form.hidden; } }, 'حذف الحساب')), form);
  }
  function renderLocked(data) {
    const x = (data && data.subscription) || S.sub || {};
    if (data && data.pricing) S.pricing = data.pricing;
    S.sub = x;
    $tabs.classList.add('hidden');
    $view.innerHTML = '';
    $view.append(h('div', { class: 'card lock' }, h('div', { class: 'lock-icon', 'aria-hidden': 'true' }, '🔒'),
      h('h1', {}, x.state === 'trial' || x.state === 'none' ? 'الفترة التجريبية خلصت' : 'اشتراكك انتهى'),
      x.endsOn ? h('p', {}, `آخر يوم كان ${dateAr(x.endsOn)}.`) : null,
      h('p', {}, 'كل أدوات أكلني مقفولة لحد ما الاشتراك الشهري يتجدد. بياناتك محفوظة زي ما هي.'),
      payInfo(),
      h('div', { class: 'actions' },
        h('a', { class: 'btn', href: '/api/export.json', download: 'eklni-my-data.json' }, 'تنزيل كل بياناتي'),
        h('button', { type: 'button', onclick: async () => { try { const me = await api('GET', '/api/me'); if (me.subscription.active) { S.sub = me.subscription; boot(); } else toast('لسه ما اتجددش'); } catch { /* shown */ } } }, 'جددت؟ تحقّق'),
        h('button', { type: 'button', class: 'danger', onclick: async () => { await api('POST', '/api/auth/logout'); S.me = null; renderAuth('login'); } }, 'تسجيل الخروج'))));
  }
  async function proOwnerCard() {
    const r = await api('GET', '/api/owner/pro');
    const act = async (path, body, msg) => { try { await api('POST', path, body); toast(msg); S.teamView = drawOwner; go('team'); } catch (ex) { toast(errMsg(ex)); } };
    return h('div', { class: 'card' }, h('h2', {}, 'طلبات توثيق الأخصائيين'),
      h('p', { class: 'small muted' }, 'التطبيق مش بيتحقق من أي سجل رسمي؛ اتأكد من الترخيص بنفسك قبل التوثيق.'),
      !r.professionals.length ? h('p', { class: 'muted small' }, 'مفيش طلبات.') : h('ul', { class: 'versions' }, r.professionals.map((p) => h('li', {},
        h('div', { dir: 'auto' }, h('strong', {}, p.email), ` · ${p.licenseNo} · ${p.issuer} · ${VER_AR[p.verification]}${p.subscription.endsOn ? ` · اشتراك أخصائي لحد ${p.subscription.endsOn}` : ''}`),
        h('div', { class: 'actions' },
          p.verification !== 'verified' ? h('button', { type: 'button', class: 'primary', onclick: () => act('/api/owner/pro/decision', { email: p.email, decision: 'verified' }, 'اتوثّق') }, 'توثيق') : null,
          p.verification === 'pending' ? h('button', { type: 'button', onclick: () => act('/api/owner/pro/decision', { email: p.email, decision: 'rejected' }, 'اترفض') }, 'رفض') : null,
          p.verification === 'verified' ? h('button', { type: 'button', class: 'danger', onclick: () => act('/api/owner/pro/decision', { email: p.email, decision: 'revoked' }, 'اتلغى') }, 'إلغاء التوثيق') : null,
          h('button', { type: 'button', onclick: () => act('/api/owner/pro/subscriptions', { email: p.email, months: 1 }, 'اتمدد شهر') }, '+ شهر أخصائي'))))));
  }
  async function drawOwner(box) {
    const r = await api('GET', '/api/owner/subscriptions');
    const f = { email: '', months: 1, note: '' };
    const res = h('div', {});
    const show = (d) => { res.innerHTML = ''; res.append(h('div', { class: 'notice info' }, h('strong', {}, d.user.email), ` — ${SUB_AR[d.subscription.state]}${d.subscription.endsOn ? ` لحد ${dateAr(d.subscription.endsOn)}` : ''}`,
      h('ul', { class: 'small' }, (d.events || []).slice(0, 8).map((e) => h('li', {}, `${e.at.slice(0, 10)} · ${e.action}${e.months ? ` ${e.months} شهر` : ''}${e.endsOn ? ` → ${e.endsOn}` : ''}${e.note ? ` · ${e.note}` : ''}`))))); };
    const email = h('input', { type: 'email', placeholder: 'إيميل المستخدم', dir: 'ltr', oninput: (e) => { f.email = e.target.value; } });
    let armed = false;
    put(box, h('div', { class: 'card' }, h('h2', {}, 'تسجيل دفع / تمديد'),
      h('label', {}, 'الإيميل'), email,
      h('label', {}, 'المدة'), h('select', { onchange: (e) => { f.months = Number(e.target.value); } }, [1, 2, 3, 6, 12].map((m) => h('option', { value: m }, `${m} شهر`))),
      h('label', {}, 'ملاحظة (مثلاً: طريقة الدفع ورقم العملية)'), h('input', { maxlength: 200, oninput: (e) => { f.note = e.target.value; } }),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'primary', onclick: async () => { try { show(await api('POST', '/api/owner/subscriptions', f)); toast('اتمدد'); } catch (ex) { toast(errMsg(ex)); } } }, 'مدّد'),
        h('button', { type: 'button', onclick: async () => { try { show(await api('GET', `/api/owner/subscriptions?email=${encodeURIComponent(f.email)}`)); } catch (ex) { toast(errMsg(ex)); } } }, 'اعرض'),
        h('button', { type: 'button', class: 'danger', onclick: async (e) => {
          if (!armed) { armed = true; e.target.textContent = 'متأكد؟ بيقفل فورًا'; return; }
          try { show(await api('POST', '/api/owner/subscriptions/cancel', { email: f.email, confirm: true })); toast('اتلغى'); } catch (ex) { toast(errMsg(ex)); }
        } }, 'إلغاء الاشتراك')), res),
      await proOwnerCard(),
      h('div', { class: 'card' }, h('h2', {}, 'المستخدمين'), h('ul', { class: 'versions' }, r.users.map((u) => h('li', { class: 'spread' },
        h('span', { dir: 'ltr' }, u.email), h('button', { type: 'button', class: 'chip', onclick: () => { email.value = u.email; f.email = u.email; show({ user: u, subscription: u.subscription, events: [] }); window.scrollTo(0, 0); } },
          `${SUB_AR[u.subscription.state]}${u.subscription.endsOn ? ` · ${u.subscription.endsOn}` : ''}`))))),
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => go(S.st?.goal ? 'more' : 'team') }, 'رجوع')));
  }

  // ---------- boot ----------
  window.addEventListener('hashchange', () => { handleLinkHash(); });
  async function boot() {
    if (await handleLinkHash()) return;
    S.meta = await api('GET', '/api/meta');
    let me;
    try { me = await api('GET', '/api/me'); S.me = me.user; } catch { return; }
    S.sub = me.subscription; S.isOwner = me.isOwner; S.hasPassword = me.hasPassword !== false; S.pricing = me.pricing; S.pro = me.pro;
    if (!me.subscription.active) { renderLocked({ subscription: me.subscription, pricing: me.pricing }); return; }
    $sub.textContent = '';
    S.st = await api('GET', '/api/state');
    if (!S.st.goal) {
      let ac = { academies: [] };
      try { ac = await api('GET', '/api/academies'); } catch { /* ignore */ }
      if (ac.academies.some((a) => a.isStaff || a.roles.includes('parent'))) { go('team'); return; }
      startWizard(); return;
    }
    go('dashboard');
  }
  boot().catch(() => { if (!S.me) renderAuth('login'); });
})();
