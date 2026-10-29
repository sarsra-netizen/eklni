'use strict';
// UI strings. Arabic is the default; add an "en" block with the same keys to enable English later.
window.I18N = {
  lang: 'ar',
  ar: {
    'nav.dashboard': 'اللوحة', 'nav.weekly': 'المتابعة', 'nav.timeline': 'الخط الزمني', 'nav.nutrition': 'التغذية', 'nav.health': 'صحتي', 'nav.more': 'المزيد',
    'goal.title': 'هدفي في خسارة الوزن',
    'unit.kg': 'كجم', 'unit.cm': 'سم', 'unit.kcal': 'سعرة', 'unit.g': 'جم', 'unit.week': 'أسبوع',
    'sex.male': 'ذكر', 'sex.female': 'أنثى',
    'goal.fat_loss': 'خسارة الدهون', 'goal.preserve_muscle': 'الحفاظ على العضلات', 'goal.performance': 'تحسين الأداء أثناء خسارة الوزن', 'goal.muscle_gain': 'زيادة الكتلة العضلية', 'goal.weight_gain': 'زيادة الدهون والكتلة العضلية', 'goal.fat_gain': 'زيادة الدهون فقط',
    'act.sedentary': 'خامل (عمل مكتبي، حركة قليلة)', 'act.light': 'نشاط خفيف', 'act.active': 'نشيط (عمل يتطلب حركة)', 'act.very_active': 'نشيط جدًا (عمل بدني)',
    'int.low': 'منخفضة', 'int.moderate': 'متوسطة', 'int.high': 'مرتفعة',
    'bf.dexa': 'DEXA (موثوقية عالية)', 'bf.skinfold': 'سُمك ثنايا الجلد بمختص (متوسطة)', 'bf.bia': 'ميزان/جهاز مقاومة كهربية (منخفضة)', 'bf.tape': 'شريط قياس (منخفضة)', 'bf.visual': 'تقدير بالنظر (منخفضة)',
    'action.continue': 'استمر بالخطة', 'action.monitor': 'تابع دون تعديل', 'action.check_first': 'راجع قبل التعديل', 'action.increase_energy': 'زيادة الطاقة', 'action.decrease_energy': 'تقليل بسيط', 'action.insufficient_data': 'بيانات غير كافية', 'action.blocked_by_guard': 'لا تقليل إضافي', 'action.blocked_by_hold': 'الخطة على الثبات',
    'status.pending': 'بانتظار قرارك', 'status.accepted': 'مقبول', 'status.rejected': 'مرفوض', 'status.superseded': 'استُبدل', 'status.info': 'معلومة',
  },
};
window.t = (key) => (window.I18N[window.I18N.lang] || {})[key] || window.I18N.ar[key] || key;
