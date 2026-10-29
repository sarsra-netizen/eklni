# قاموس البيانات — أكلني | Eklni

الوحدات: الوزن كجم، الطول سم، الطاقة سعرة (kcal)، الماكروز جرام، السوائل لتر، الوقت دقائق، التواريخ `YYYY-MM-DD`، الأوقات ISO-8601 UTC.
القاعدة: **القيمة غير المعروفة = `null` وليست صفرًا.**

## الجداول (SQLite — `src/db.js`)

| الجدول | المفتاح | أهم الحقول | ملاحظات |
|---|---|---|---|
| `users` | id | email (فريد، lowercase)، pass_hash (scrypt)، created_at | |
| `sessions` | token_hash | user_id، expires_at | يُخزَّن SHA-256 للتوكن فقط |
| `goals` | id | user_id، active، input_json، plan_json، start_weight، target_weight، weekly_rate_kg، calorie_adjustment | الهدف القديم يبقى (active=0) |
| `weights` | (goal_id, date) | weight_kg | |
| `checkins` | (goal_id, week) | data_json: waistCm، bodyFatPct، adherencePct، performance/hunger/energy/sleep/recovery (1–5) | |
| `adjustments` | id | kind، action، kcal_change، reasons_json، status (pending/accepted/rejected/superseded/info) | سجل كل تعديل وسببه |
| `prefs` | user_id | data_json (تفضيلات الخطة والجدول) | |
| `weekplans` | id | goal_id، created_at، **reason**، data_json | نسخة لكل تعديل؛ آخر 30 نسخة |
| `competitions` | user_id | data_json | |
| `notification_settings` | user_id | data_json | الإرسال غير مفعّل |
| `screenings` | user_id | data_json، consent_at، updated_at | إجابات الفحص الصحي — بيانات صحية حساسة |
| `hydration_logs` | id | user_id، date، data_json | حصص معدل التعرق |
| `academies` | id | name، created_by، created_at | |
| `memberships` | (academy_id, user_id, role) | role ∈ admin/coach/dietitian/athlete/parent، display_name | الشخص ممكن يبقى له أكتر من دور |
| `invites` | code_hash | academy_id، role، athlete_id (لولي الأمر)، expires_at، used_by | الكود نفسه لا يُخزَّن |
| `guardians` | (academy_id, parent_id, athlete_id) | | ربط ولي الأمر باللاعب |
| `sharing` | (academy_id, athlete_id) | share_health، decided_by، decided_at | موافقة مشاركة البيانات الصحية مع الأخصائي |
| `subscriptions` | user_id | plan (monthly)، status (trial/active/canceled)، starts_on، ends_on (آخر يوم مشمول) | |
| `subscription_events` | id | user_id، action (trial/extend/cancel)، months، ends_on، by_user، note | سجل الدفع والتمديد |
| `academy_branding` | academy_id | signature، logo (data URL) | للتقرير وملف التغذية |
| `platform_owners` | user_id | granted_at | بيتمنح من السيرفر بس |
| `notifications` | id | user_id، kind، due_key (فريد لكل مستخدم)، title، body، read_at، external_status، external_attempts | صندوق التنبيهات؛ من غير بيانات صحية |
| `professionals` | user_id | license_no، issuer، status (pending/verified/rejected/revoked)، decided_at، decided_by، note | توثيق الأخصائي بقرار بشري |
| `pro_subscriptions` | user_id | status، starts_on، ends_on | منفصل عن `subscriptions` |
| `audit_log` | id | at، academy_id، actor_id، action، target_id | بدون أي بيانات صحية |
| `meal_logs` | user_id + date + key | goal_id، entry (JSON: الحالة، الجزء المأكول، نسخة من مكونات الوجبة × الجزء، الإجمالي)، logged_at | مراجعة 2026-10-22: الأكل المسجّل، منفصل عن الخطة والهدف. key = `m<رقم الوجبة>` أو `a<رقم الإضافة>` |
| `plan_reviews` | id | athlete_id، goal_id، reviewer_id، academy_id، decision (approved / revision_requested / rejected / referred)، note، fingerprint (بصمة الأهداف وقت المراجعة)، calc_version، created_at | مراجعة 2026-10-22: لو الأهداف اتغيرت المراجعة بتبقى «قديمة» |
| `calorie_overrides` | user_id | kcal، starts_on، ends_on (من يوم لـ 7 أيام)، created_at | 0.7.0: سعرات يختارها الشخص؛ بعد ends_on مش بتتحسب |
| `self_waivers` | user_id | accepted_at، text_version | 0.7.0: إقرار البالغ إن الخطة على مسؤوليته؛ الإلغاء بيمسح الصف |
| `households` | id | name، created_by (مسؤول البيت)، shared_meals (`breakfast,lunch,dinner`)، created_at | 0.7.0 |
| `household_members` | user_id (عضوية واحدة للشخص) | household_id، display_name، joined_at | ترتيب الانضمام بيحدد مين بيحط أكل البيت لما أكتر من حد عنده خطة |
| `household_invites` | code_hash | household_id، created_by، expires_at (7 أيام)، used_by | لمرة واحدة |
| `user_identities` | (provider، subject) | user_id، created_at | 0.7.0: ربط حساب جوجل (`sub`) بالمستخدم. حساب جوجل بس ليه `pass_hash = none$google` (مش ممكن يتطابق مع أي كلمة مرور) |
| `share_links` | id | token_hash (فريد)، user_id، html، created_at، expires_at (ms)، revoked_at، views | 0.7.0: نسخة خطة للقراءة بس |
| `minor_consents` | athlete_id | guardian_id، academy_id، granted_at | 0.7.0: موافقة ولي الأمر على خسارة الوزن (12–17). صالحة بس طول ما الربط موجود |
| `academies.kind` | — | `academy` أو `family` | 0.7.0: «عائلة» بتتعمل لما اللاعب يدعو ولي أمره |

## مدخلات الهدف (`validateGoalInput`)
sex، age (12–90)، heightCm، currentWeight، targetWeight، bodyFatPct + bodyFatMethod (dexa/skinfold/bia/tape/visual)، waistCm، primaryGoal (fat_loss/preserve_muscle/performance للخسارة، muscle_gain/weight_gain/fat_gain للزيادة — والزيادة الوزن المستهدف فيها أعلى من الحالي)، isAthlete، fullName، activityLevel، sport، **swimDiscipline** (sprint/middle/distance/open_water/mono/bi_fins/apnea)، sessionsPerWeek، minutesPerSession، intensity، seasonPhase، competitionDate، **measuredRmr** (800–5000)، مؤشرات الجوع/الطاقة/النوم/الالتزام، medicalCondition، weightMedication، pregnantOrBreastfeeding.

## الفحص الصحي (`validateScreening`)
| الحقل | القيم |
|---|---|
| consent | إلزامي true |
| menstrual | regular / irregular / absent / hormonal_contraception / not_sure / null |
| eating[] | preoccupied / compensate / purge / loss_of_control |
| boneStressInjury، recurrentIllness، persistentFatigue، performanceDrop، unintendedWeightLoss | boolean |
| conditions[] | diabetes / heart / hypertension / kidney / gi / thyroid / metabolic_inherited / cancer / other |
| medications، supplements، pregnantOrBreastfeeding، professionalClearance | boolean |
| impairment | none / sci / amputation / cp_abi / visual / other |

## حصة الترطيب (`validateSession`)
date، preKg، postKg (فرق ≤5 كجم)، durationMin (10–360)، fluidL (0–6)، urineL (0–3)، environment (pool_indoor/pool_outdoor/open_water/land_hot/land_mild)، note. يُرفض معدل >4 لتر/ساعة أو عرق سالب.
المخرجات: sweatLossL، sweatRateLph، bodyMassChangeKg، bodyMassChangePct، replacedPct، flags[]، advice[].

## الأطعمة (`src/data/foods.json`) — لكل 100 جم
id، ar، en، group، state (raw/cooked/ready)، kcal، protein، carb، fat، fiber، ironMg?، vitDug?، calciumMg? (غير مسجل)، source، proxy، proteinType، allergens، fasting، **reviewedAt**، **reviewedBy** (null = لم يُراجع)، reviewNote، history[] (القيم السابقة عند كل مراجعة). مستوى الثقة المحسوب: reviewed / unreviewed / proxy.

## المراجع (`src/data/references.json`)
id، title، authors، year، publisher، isbn?، url? (فقط لو مطبوع داخل المرجع)، usedFor[] {topic، location، detail}. و`appRules` = القواعد غير المرجعية.
