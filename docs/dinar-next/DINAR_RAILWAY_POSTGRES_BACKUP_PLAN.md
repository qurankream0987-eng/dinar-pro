# DINAR — خطة النسخة المنطقية الآمنة والاستعادة المعزولة

**الحالة:** `TOOLCHAIN_PREPARED — REAL EXPORT BLOCKED`<br>
**التاريخ:** 2026-10-24<br>
**النطاق:** قاعدة Railway development فقط؛ لا اتصال Railway أو تصدير بيانات حقيقية. أُجريت بروفة محلية ببيانات مصطنعة فقط.

## الملخص

أكد المالك من لوحة Railway أن خدمة Postgres تعرض **No Backups**. لا يثبت ذلك حالة PITR؛ تبقى غير مؤكدة. بيانات الهدف والنسخة أدناه من سجلات Railway المعتمدة ومن فحص metadata للقراءة فقط. قياس الحجم كان استعلامًا تجميعيًا واحدًا داخل `BEGIN READ ONLY` وTLS مثبت؛ لا قرأ صفوف مستخدمين ولا غيّر القاعدة.

النسخة المخطط لها: `pg_dump` بصيغة custom، يمر مباشرة إلى `age` بحيث لا يكتب dump غير مشفر إلى القرص. الوجهة المطلوبة قرص خارجي مشفر يملكه المالك، خارج Replit وRailway. بروفة الاستعادة ستكون على PostgreSQL 18 محلي مؤقت، Unix socket فقط، بلا تطبيق متصل، ثم يحذف مجلد البيانات المؤقت.

**لا تبدأ التصدير الحقيقي**؛ تفويض المالك الحالي يقتصر على تجهيز الأدوات. يلزم قبل أي تصدير اعتماد صريح منفصل، وجهة خارجية مشفرة، وسياسة احتفاظ ومفتاح يسيطر عليهما المالك. لا تستخدم النسخة المحلية العامة من PostgreSQL 16/17 ضد خادم 18.6.

## 1. الهدف المحدد والتحقق

| الحقل | القيمة المعتمدة |
| --- | --- |
| Railway project | `dinar-development-canonical` |
| Project ID | `3810e583-cc70-434c-b6fa-9ea15779f3c1` |
| Environment | `development` — ID `4086de25-d270-4f39-89d1-93f611fe79c2` |
| PostgreSQL service | `Postgres` — ID `6a02fe25-1305-437c-9fe7-b989836c8949` |
| Database | `railway` |
| اتصال TCP proxy | `iriguchi.proxy.rlwy.net:18992` |
| هوية TLS المطلوبة | `postgres-57f7f853.railway.internal` |
| إصدار الخادم | PostgreSQL **18.6** |
| حجم القاعدة | **14,440,127 bytes** (يعرضه PostgreSQL تقريبًا `14 MB`) |
| حجم Railway volume الوارد في metadata | `500 MB` في `iad` |
| النسخ من لوحة المالك | **No Backups** |
| PITR | غير متحقق؛ لا تفترض أنه مفعّل أو متوقف |

تم تثبيت عنوان الاتصال واسم خدمة TLS في `lib/db/src/development-tls.ts`. يستبدل الكود اسم proxy بهوية الشهادة المثبتة، ويرفض TLS غير الموثق. libpq لا يقرأ callback الخاص بـNode؛ في الخطة يُستخدم `host` لهوية الشهادة و`hostaddr` لعنوان IP الذي يحلّ إليه TCP proxy، مع `sslmode=verify-full` وملف CA المثبت نفسه. لا تستبدل ذلك بـ`sslmode=require` أو `verify-ca`، ولا تستخدم عنوانًا/شهادة غير متحقق منهما.

## 2. الأدوات المطلوبة وحالتها هنا

| الأداة | المطلوب | الموجود في مساحة العمل الآن |
| --- | --- | --- |
| `pg_dump`, `pg_restore`, `psql` | PostgreSQL **18.x**؛ الأفضل 18.6 | PATH العام ما زال 16.10؛ أدوات 18.6 متاحة داخل Nix shell مؤقت ومثبت أدناه |
| `initdb`, `pg_ctl`, `postgres` | PostgreSQL **18.x** لبروفة محلية مطابقة | PATH العام 16.10؛ أدوات 18.6 داخل Nix shell المؤقت |
| `age`, `age-keygen` | إصدار حديث من age | PATH العام لا يحتويهما؛ نسخة 1.3.2 متاحة داخل Nix shell المؤقت |
| `sha256sum`, `findmnt`, `getent`, `python3` | بصمة، تحقق من وسيط التخزين وDNS، واختيار منفذ محلي | يلزم فحصها على جهاز التنفيذ |
| مساحة تخزين خارجية مشفرة | يملكها المالك، قابلة للفصل، خارج repo/deploy/Railway | غير متاحة هنا: `/mnt` overlay سعته 4 MB؛ `/tmp` ذاكرة مؤقتة 4 GB وليست وجهة دائمة |

PostgreSQL 18 `pg_dump` يستطيع إخراج custom archive، لكنه **يرفض** dump من server major أحدث من client major؛ لذلك لا يصلح 16.10 أو 16.15 أو 17.6 لخادم 18.6. جُهزت بيئة أدوات مؤقتة ومثبتة على commit رسمي من Nixpkgs، بلا تعديل ملفات التطبيق أو workflows أو إعدادات المستودع:

```sh
nix shell \
  'github:NixOS/nixpkgs/da6dc0e7b26060f2f71ce3ef7088fb56ee44fa36#postgresql_18' \
  'github:NixOS/nixpkgs/da6dc0e7b26060f2f71ce3ef7088fb56ee44fa36#age' \
  --command bash
```

الإصدارات المتحققة داخلها: PostgreSQL `18.6` لكل من `pg_dump`, `pg_restore`, `initdb`, `pg_ctl`, `postgres`؛ وage `1.3.2`. تثبيت Nixpkgs محدد بالـcommit `da6dc0e7b26060f2f71ce3ef7088fb56ee44fa36`، وليس alias متحرك. الأدوات ليست في PATH العام ولا تضيف اعتمادًا إلى التطبيق أو نشره.

### نتيجة البروفة المصطنعة

داخل Nix shell، شُغّل PostgreSQL 18.6 مؤقتًا من مجلد خاص تحت `/tmp`، مع Unix socket فقط، وأنشئ مخطط مصغر ببيانات اصطناعية، لا من migrations المشروع ولا من Railway. نجحت الخطوات التالية:

- `pg_dump` custom archive إلى stdout ثم تشفير streaming بـ`age 1.3.2`.
- تحقق SHA-256، وفك تشفير إلى stdin لقراءة فهرس الأرشيف واستعادته إلى قاعدة منفصلة.
- تطابقت counts المصدر والاستعادة لكل الجداول الاصطناعية، وكذلك دفتر migrations الاصطناعي (3 صفوف وبصمة مطابقة).
- كان ملف النسخة المشفرة بصلاحية `0600` وحجمه 25,421 بايتًا؛ لم يوجد ملف dump plaintext محفوظ. حُذفت قاعدة الاختبار ومجلدها ومفتاح age المؤقت بعد التحقق.

أثناء إعداد صيغة الأنابيب، كشفت تجربة أولى أن `pg_dump --file=-` ينشئ ملفًا حرفيًا باسم `-` بدل الإخراج إلى stdout؛ احتوى على بيانات الاختبار الاصطناعية فقط. أُعيد الملف المتعقب إلى نسخته الأصلية من Git ثم أُعيد الاختبار بصيغة صحيحة دون وسيط ملف لـ`pg_dump` أو `pg_restore`. لم يتصل الاختبار بـRailway أو يتضمن سجلات حقيقية، ولا توجد ملفات اختبار متبقية.

كان حجم الأرشيف المصطنع 25,421 بايتًا، ولا يصلح لتعديل تقدير حجم قاعدة DINAR. هذا الاختبار يثبت مسار الأدوات والتشفير والاستعادة على عينة مصطنعة، وليس توافق المخطط الكامل أو استعادة نسخة حقيقية. لم يُنشأ أو يُستخدم مفتاح المالك.

`pg_dump` ينسخ قاعدة واحدة كاملة من schema/data/large objects؛ لا ينسخ roles أو tablespaces العامة على مستوى cluster. لم تُضف `--schema` أو `--table` أو خيارات استبعاد بيانات. لا تنفّذ `pg_dumpall --globals-only` ضمن هذه الخطة.

## 3. الحجم المتوقع

الحجم المقاس للقاعدة **14.44 MB (13.77 MiB)**، بينما سعة volume هي 500 MB. صيغة custom تضغط افتراضيًا، والفهارس تُعاد بناؤها عند الاستعادة؛ لذلك التقدير الأولي لملف dump المضغوط **5–20 MB**. هذا تقدير تخطيطي وليس حجم نسخة فعلية أو ضمانًا. احجز **100 MB على الأقل لكل نسخة**، وتحقق من الحجم الفعلي بعد التصدير. لا تستخدم سعة volume نفسها كوجهة النسخة.

## 4. وجهة التخزين والتشفير والاحتفاظ

### الوجهة

- الوجهة الأساسية الموصى بها: قرص SSD خارجي **مشفر على مستوى نظام الملفات**، مملوك للمالك ومركب على محطة عمل موثوقة، خارج workspace/repository وقرص التطبيق وRailway volume. لا تنشئ ملف النسخة في مجلد المشروع أو `/mnt` الحالي أو `/tmp` الدائم (فهو مؤقت).
- احتفظ بنسخة ثانية مشفرة على وسيط خارجي منفصل في موقع منفصل، إذا كانت سياسة DINAR تسمح بذلك؛ لا تستخدم bucket أو خدمة سحابية جديدة الآن.
- قبل الاستخدام، تحقق يدويًا من أن الوجهة mount خارجي فعلي، لا مجلدًا أنشأه `mkdir` على القرص المحلي:

```sh
export BACKUP_DIR=/absolute/path/on/owner-encrypted-external-ssd/dinar
test -d "$BACKUP_DIR"
findmnt -T "$BACKUP_DIR" -o SOURCE,FSTYPE,TARGET
df -h "$BACKUP_DIR"
```

**توقف** إذا لم تكن `SOURCE`/`TARGET` وسيط التخزين الخارجي المعتمد، أو إذا لم تتوفر مساحة خالية كافية. لا تُنشئ المسار تلقائيًا قبل التحقق من mount.

### التشفير والصلاحيات

- استخدم age بمفتاح recipient عام مخصص للمالك؛ اجعل التشفير streaming من stdout إلى ملف `.dump.age`، بلا نسخة plaintext وسيطة.
- احفظ مفتاح age الخاص خارج وسيط النسخة، في مدير مفاتيح/وسيط offline منفصل مع مالك احتياطي معتمد. لا تحفظ المفتاح الخاص بجانب النسخة ولا تطبعه في terminal أو التقرير. ملف recipient العام ليس سرًا.
- فعّل تشفير القرص الخارجي أيضًا؛ age يحمي الملف عند النقل أو فقد الوسيط، وتشفير القرص يحمي بقية metadata المؤقتة.
- `umask 077`، مجلدات إعداد/سجلات بصلاحية `0700`، ملفات الخدمة و`.pgpass` والنسخة والسجلات بصلاحية `0600`.
- لا تضع URL اتصال يحوي password في command line أو shell history أو process listing. لا تستخدم `PGPASSWORD` أو `--verbose`. خزّن الاعتماد فقط في `PGPASSFILE` الخاص؛ لا تطبع محتوى `PGSERVICEFILE` أو `.pgpass`.
- احتفاظ مقترح بانتظار اعتماد المالك: يومي 7 أيام، أسبوعي 4 أسابيع، شهري 3 أشهر؛ احتفظ على الأقل بثلاث نسخ مشفرة سليمة. لا تحذف آخر نسخة قابلة للاستعادة، ولا تحذف نسخة قبل نجاح checksum وبروفة استعادة موثقة. لا توجد سياسة معتمدة حاليًا.

## 5. إعداد اتصال libpq دون كشف الاعتماد

نفّذ هذه الخطوة لاحقًا على محطة المالك الموثوقة، بعد الموافقة فقط. CA يجب أن يكون النسخة المثبتة من `developmentCa` في `lib/db/src/development-tls.ts` بعد التحقق من بصمته من مصدر مستقل، لا CA عشوائيًا. اكتب ملف خدمة libpq داخل مجلد خاص خارج المستودع:

```ini
[dinar-preview]
host=postgres-57f7f853.railway.internal
hostaddr=<IP واحد متحقق من DNS للـTCP proxy وقت الاتصال>
port=18992
dbname=railway
user=<اسم المستخدم المعتمد من مخزن الأسرار>
sslmode=verify-full
sslrootcert=<مسار ملف CA المثبت خارج المستودع>
connect_timeout=15
application_name=dinar-logical-backup
```

اضبط `PGSERVICEFILE` و`PGPASSFILE` على ملفات خاصة بصلاحية `0600`. أدخل كلمة المرور من مخزن الأسرار المعتمد مباشرة إلى `.pgpass` بأداة لا تطبعها، مع تهريب `:` و`\` وفق صيغة `.pgpass`. لا تستخدم سر الإنتاج؛ الهدف الوحيد هو قاعدة development أعلاه. استخدم `getent ahostsv4 iriguchi.proxy.rlwy.net` لتحديد IP للـ`hostaddr` وقت التشغيل ولا تخزّن IP قديمًا. `host` يبقى هو اسم الشهادة الداخلي ليظل `verify-full` يتحقق من هوية الخدمة.

قبل dump، نفّذ فحص هوية واحدًا فقط، واقرأ النتيجة محليًا:

```sh
export PGSERVICEFILE="$HOME/.config/dinar-backup/pg_service.conf"
export PGPASSFILE="$HOME/.config/dinar-backup/pgpass"
export PGSERVICE=dinar-preview
psql "service=$PGSERVICE" -X -v ON_ERROR_STOP=1 -Atc \
  "SELECT current_setting('server_version'),
          pg_size_pretty(pg_database_size(current_database())),
          (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid());"
```

يجب أن يظهر PostgreSQL 18.x، وحجم قاعدة متسقًا تقريبًا مع 14 MB، وTLS=`t`. لا تحفظ أو تشارك مخرجات اتصال أكثر من هذه القيم. عند أي اختلاف في version/size/target/TLS، توقف وراجع الهدف قبل أي تصدير.

## 6. أوامر النسخ — لا تُشغّلها في هذه المهمة

المتطلبات المسبقة: موافقة المالك أدناه، وسيط خارجي مثبت ومتحقق، أدوات PG18، age، CA موثّق، `PGSERVICEFILE`/`PGPASSFILE` خاصان، و`AGE_RECIPIENT` عام معتمد. هذا مثال مشروط؛ المسارات وrecipient تُستبدل بعد التحقق، ولا يحتوي المثال على أي credential:

```sh
set -euo pipefail
umask 077
export PGSERVICEFILE="$HOME/.config/dinar-backup/pg_service.conf"
export PGPASSFILE="$HOME/.config/dinar-backup/pgpass"
export PGSERVICE=dinar-preview
export BACKUP_DIR=/absolute/path/on/owner-encrypted-external-ssd/dinar
export AGE_RECIPIENT='<owner-approved-age-public-recipient>'

test -d "$BACKUP_DIR"
findmnt -T "$BACKUP_DIR" -o SOURCE,FSTYPE,TARGET
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL="$BACKUP_DIR/dinar-development-$STAMP.dump.age"
PART="$BACKUP_DIR/.dinar-development-$STAMP.partial"
LOG="$BACKUP_DIR/dinar-development-$STAMP.log"
trap 'rm -f -- "$PART"' EXIT

# لا --verbose؛ لا URL أو كلمة مرور في argv. pg_dump يكتب custom archive إلى stdout،
# وage يشفّره قبل أن يصل أي byte إلى التخزين.
pg_dump --dbname="service=$PGSERVICE" --format=custom --lock-wait-timeout=30s \
  2>"$LOG" |
  age --recipient "$AGE_RECIPIENT" --output "$PART"

test -s "$PART"
chmod 0600 "$PART" "$LOG"
mv -- "$PART" "$FINAL"
sha256sum "$FINAL" >"$FINAL.sha256"
chmod 0600 "$FINAL" "$FINAL.sha256"
sha256sum --check "$FINAL.sha256"
```

بعد اكتمال النسخة، افحص قابلية فك التشفير وقراءة فهرس archive دون طباعة أسماء الجداول أو إنشاء plaintext file:

```sh
age --decrypt --identity "$AGE_IDENTITY_FILE" "$FINAL" |
  "$PG18_BIN/pg_restore" --list >/dev/null
```

احفظ سجل exit code ووقت التنفيذ والحجم والبصمة فقط في manifest محمي؛ لا تحفظ سطر الاتصال أو كلمات المرور أو محتوى الصفوف. أخطاء `pg_dump` تبقى في log بصلاحية `0600`، ويُراجعها المالك محليًا قبل مشاركة أي مقتطف. ملف dump يحتوي بيانات شخصية ومالية حتى وهو مشفر؛ لا ترسله إلى المحادثة.

## 7. بروفة الاستعادة المعزولة

### شروط العزل

- محطة موثوقة محلية أو قاعدة loopback مؤقتة فقط، مثبت عليها PostgreSQL 18.x. لا Railway sibling ولا Replit database ولا خدمة مدفوعة.
- بيانات PostgreSQL في مجلد مؤقت خارج المستودع؛ لا `DATABASE_URL` للتطبيق، لا API server، ولا اتصال خارجي. Unix socket فقط؛ لا تعرض المنفذ على الشبكة.
- اقرأ النسخة المشفرة مباشرة إلى `pg_restore` عبر pipe حتى لا يتكوّن dump plaintext على القرص. `--single-transaction --exit-on-error` يمنع قبول استعادة جزئية. لا تستخدم `--clean` أو `--create`.
- استخدم ملفات `pg18` المتطابقة مع 18.x؛ لا تستخدم binaries 16/17 الموجودة في workspace.

بعد موافقة المالك وتجهيز حزمة PG18، مثال البروفة:

```sh
set -euo pipefail
umask 077
export PG18_BIN=/absolute/path/to/postgresql-18/bin
export BACKUP_DIR=/absolute/path/on/owner-encrypted-external-ssd/dinar
export FINAL="$BACKUP_DIR/<verified-dump-name>.dump.age"
export AGE_IDENTITY_FILE=/secure/offline-mounted/path/owner-age-identity

"$PG18_BIN/initdb" --version
"$PG18_BIN/pg_restore" --version
"$PG18_BIN/initdb" --version | grep -q 'PostgreSQL 18\\.'
"$PG18_BIN/pg_restore" --version | grep -q 'PostgreSQL 18\\.'

# تحقق من البصمة ثم archive integrity قبل إنشاء instance.
sha256sum --check "$FINAL.sha256"
age --decrypt --identity "$AGE_IDENTITY_FILE" "$FINAL" |
  "$PG18_BIN/pg_restore" --list >/dev/null

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dinar-pg18-restore.XXXXXX")"
chmod 0700 "$WORK"
DATA="$WORK/data"
SOCKET="$WORK/socket"
mkdir -m 0700 "$SOCKET"
PORT=55439
RESTORE_DB=dinar_restore_rehearsal
cleanup() {
  "$PG18_BIN/pg_ctl" -D "$DATA" stop -m fast >/dev/null 2>&1 || true
  rm -rf -- "$WORK"
}
trap cleanup EXIT

"$PG18_BIN/initdb" -D "$DATA" --username="$(id -un)" \
  --auth-local=peer --auth-host=scram-sha-256 --data-checksums
cat >>"$DATA/postgresql.conf" <<EOF
listen_addresses = ''
unix_socket_directories = '$SOCKET'
port = $PORT
EOF
"$PG18_BIN/pg_ctl" -D "$DATA" -l "$WORK/postgres.log" start
"$PG18_BIN/createdb" -h "$SOCKET" -p "$PORT" --template=template0 "$RESTORE_DB"

age --decrypt --identity "$AGE_IDENTITY_FILE" "$FINAL" |
  "$PG18_BIN/pg_restore" --exit-on-error --single-transaction \
    --no-owner --no-privileges \
    --dbname="host=$SOCKET port=$PORT dbname=$RESTORE_DB user=$(id -un)"
```

`PORT` أعلاه مثال؛ تحقق من خلوه قبل التشغيل، أو اختر منفذ loopback محليًا متاحًا. لا تغيّر `listen_addresses=''` ولا تربط الخدمة بعنوان عام. بعد الفحوص، أوقف PostgreSQL واحذف `$WORK` عبر `trap`; لا تنسخ بيانات الاستعادة إلى أي قاعدة دائمة. إذا لم يوجد PG18 محلي أو كان `$TMPDIR` غير مؤقت/غير خاص، لا تبدأ البروفة.

### فحوص سلامة بلا عرض صفوف

قبل dump وبعد restore، قارن فقط مجاميع counts محفوظة داخل manifest مشفر ومحمي. لا تطبع IDs أو هواتف أو رسائل أو قيم مبالغ:

```sql
SELECT 'users' AS entity, count(*) FROM public.users
UNION ALL SELECT 'offers', count(*) FROM public.offers
UNION ALL SELECT 'orders', count(*) FROM public.orders
UNION ALL SELECT 'order_items', count(*) FROM public.order_items
UNION ALL SELECT 'negotiations', count(*) FROM public.negotiations
UNION ALL SELECT 'negotiation_events', count(*) FROM public.negotiation_events
UNION ALL SELECT 'payment_intents', count(*) FROM public.payment_intents
UNION ALL SELECT 'payment_events', count(*) FROM public.payment_events
UNION ALL SELECT 'payment_refunds', count(*) FROM public.payment_refunds
UNION ALL SELECT 'payment_dispute_events', count(*) FROM public.payment_dispute_events
UNION ALL SELECT 'payment_reconciliation_runs', count(*) FROM public.payment_reconciliation_runs
UNION ALL SELECT 'payment_reconciliation_items', count(*) FROM public.payment_reconciliation_items
UNION ALL SELECT 'seller_dues', count(*) FROM public.seller_dues
UNION ALL SELECT 'conversations', count(*) FROM public.conversations
UNION ALL SELECT 'messages', count(*) FROM public.messages
UNION ALL SELECT 'sessions', count(*) FROM public.sessions
UNION ALL SELECT 'drizzle.__drizzle_migrations',
  (SELECT count(*) FROM drizzle.__drizzle_migrations)
ORDER BY entity;
```

التفسير المحدد:

1. **Accounts:** `users` إجمالي العدد فقط؛ قارن العدد المصدر/المستعاد. لا تعرض `phone_number`, `normalized_phone`, `password_hash` أو مفاتيح الحساب.
2. **Offers:** إجمالي `offers`، ثم counts حسب `pricing_mode` فقط. لا تعرض العنوان أو الوصف أو seller IDs.
3. **Orders:** counts لـ`orders` و`order_items`؛ تحقق عبر `pg_restore --exit-on-error` وقيود FK أن العناصر مرتبطة. لا تُقارن أسعار الطلب مع السعر الحالي للعرض؛ الطلب يحفظ snapshot تاريخيًا.
4. **Negotiations:** counts للحالات من `negotiations` ولأحداث `negotiation_events`؛ افحص أن القيود العلائقية/المبالغ validated بعد الاستعادة دون طباعة أطراف أو أسعار.
5. **Payments:** DINAR يخزن `payment_intents`, `payment_events`, `payment_refunds`, `payment_dispute_events`, `payment_reconciliation_runs/items` و`seller_dues`; هذه سجلات قاعدة بيانات لا تثبت تحصيل مزود فعلي. قارن counts والحالات فقط، ولا تعرض المبالغ أو مراجع المزود أو الأطراف.
6. **Conversations:** counts لـ`conversations` حسب `kind` و`messages`; لا تطبع body أو owner IDs.
7. **Migration ledger:** قارن count وhash/`created_at` لكل صف في `drizzle.__drizzle_migrations` مع prefix الـ40-entry الحالي في `lib/db/drizzle/meta/_journal.json` وملفات SQL. المتوقع من المصدر الحالي **28 صفًا، آخرها `0027_personal_intelligence`**؛ لا تُشغّل migrations أثناء البروفة.
8. افحص جداول/فهارس/قيود/مشغّلات/دوال عبر `pg_restore` الناجح ومقارنة catalog summary المصدر/الاستعادة. فشل checksum أو archive listing أو أي count/ledger mismatch = **فشل البروفة**؛ احتفظ بالنسخة المشفرة، لا تحاول إصلاح dump بتعديل SQL، واحتفظ برسالة الخطأ فقط داخل سجل خاص.

## 8. منع تسرب بيانات الاعتماد والبيانات

- لا يوجد production URL أو secret أو كلمة مرور أو token في هذه الخطة.
- لا تستخدم connection string كاملًا كوسيط `pg_dump`, `psql`, أو `pg_restore`؛ لا تفعّل shell tracing (`set -x`)، ولا تنسخ مخرجات environment variables.
- يحتفظ `.pgpass` بسر قاعدة development بصلاحية `0600` خارج repo؛ يمر `pg_dump` اسم service فقط. ملف CA عام وليس credential. recipient العام ليس سرًا، بينما age identity الخاص secret.
- `pg_dump` stderr قد يتضمن أسماء objects عند التحذير؛ لا تفعّل `--verbose`، خزّن log خاصًا، ولا تلصق محتواه هنا قبل تنقيحه. لا تسجّل الاستعلامات أو مخرجات الجدول/الصف.
- النسخة تشمل PII شديدة الحساسية: أرقام الحسابات، password hashes، sessions، رسائل المحادثات، أوامر/مفاوضات وسجلات الدفع. ملف dump المشفر يظل بيانات محمية؛ لا تفتحه أو تربطه بالتطبيق أثناء البروفة.
- النطاق development حصراً. لم يُفحص production ولم يُستخدم أي من أسراره.

## 9. قائمة موافقة المالك قبل التنفيذ

- [ ] تأكيد الهدف أعلاه والخدمة `Postgres`/development فقط؛ لا production.
- [ ] موافقة صريحة على **تصدير نسخة كاملة** تشمل PII وpassword hashes وsessions/messages والبيانات المالية المحاكاة.
- [ ] تحديد مشغل النسخ والمضيف الموثوق، ووجهة SSD خارجية فعلية مشفرة، وحيازة النسخة الثانية ومكان حفظها.
- [ ] اعتماد recipient age، مالك/بديل مفتاح فك التشفير، اختبار استرداد المفتاح، ومدة الاحتفاظ والحذف الآمن.
- [ ] تأكيد اعتماد credential قراءة مسموح به، وتوفّر CA المثبت وDNS/`hostaddr` مع استمرار `verify-full`. لا ننشئ database role أو نغير Railway config ضمن القيود الحالية.
- [ ] توفير PostgreSQL 18.x client/server و`age` على محطة التنفيذ، ثم مراجعة الإصدارات والمسارات والصلاحيات قبل أي اتصال.
- [ ] اعتماد بروفة محلية مؤقتة، وقتها، مساحة tmpfs، تنظيف `$WORK`، ومنع تشغيل التطبيق أو الاتصال بقاعدة دائمة.
- [ ] الاتفاق على نتائج القبول: checksum صحيح، archive قابل للقراءة، تطابق مجاميع الجداول والدفتر، ولا سجل يحوي أسرارًا/صفوفًا.
- [ ] فصل أي قرار لاحق بشأن Railway volume backups أو PITR؛ تفعيلهما يغيّر إعداد/نشر Railway ويتطلب موافقة مستقلة خارج هذه المهمة.

## 10. الحالة والقرار

**الجاهزية: `TOOLCHAIN_PREPARED — REAL EXPORT BLOCKED`.** تتوفر أدوات PG 18.6 وage 1.3.2 في Nix shell مؤقت مثبت؛ واكتملت بروفة مشفرة واستعادة ببيانات اصطناعية فقط. لم تُجرَ أي تغييرات على التطبيق أو workflows أو Railway، ولم يُشغّل `pg_dump` على Railway. ما زالت الوجهة الخارجية ومفتاح المالك وسياسة الاحتفاظ والموافقة الصريحة على تصدير PII غير متوفرة. لا تشغّل dump حقيقيًا أو تنشئ خدمة تخزين سحابية. تتطلب أي خطوة لاحقة موافقات §9؛ هذه الوثيقة لا تمنح تفويضًا بالتصدير.

## المراجع الرسمية

- Railway — [Back Up and Restore Postgres](https://docs.railway.com/guides/postgres-backups-restores): الفرق بين volume snapshots وPITR والنسخ المنطقية؛ `pg_dump` custom وrestore drill. استعادة volume in-place تختلف عن PITR الذي ينشئ sibling.
- Railway — [PostgreSQL CLI](https://docs.railway.com/cli/postgres): توثيق أن PITR restore ينشئ خدمة شقيقة، بينما volume-backup restore يعيد البيانات إلى الخدمة نفسها.
- PostgreSQL 18 — [`pg_dump`](https://www.postgresql.org/docs/18/app-pgdump.html): custom archive مضغوط افتراضيًا؛ قاعدة واحدة، ولا ينسخ roles/tablespaces العامة؛ client أقدم يرفض server major أحدث.
- PostgreSQL 18 — [`pg_restore`](https://www.postgresql.org/docs/18/app-pgrestore.html): استعادة custom archive، `--exit-on-error`, `--single-transaction`, وقراءة الأرشيف من stdin.
- PostgreSQL 18 — [libpq connection parameters](https://www.postgresql.org/docs/18/libpq-connect.html) و[SSL support](https://www.postgresql.org/docs/18/libpq-ssl.html): `hostaddr` مع `host` للتحقق من hostname، و`verify-full` لفحص CA وهوية الشهادة.
- age — [وثائق CLI الرسمية](https://age-encryption.org/): التشفير إلى public recipient، وفك التشفير بملف identity منفصل، مع دعم الأنابيب.
