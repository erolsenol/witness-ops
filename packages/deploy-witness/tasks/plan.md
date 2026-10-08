# DeployWitness 0.2+ — Genişletilmiş Ürün ve Teknik Plan

## Aktif release planı — 0.5.0 (2026-10-04)

**Sonuç:** 0.5.0 tamamlandı. 229 test, lint/typecheck/schema/build/packed consumer, npm audit (0 açık), development/main ve PR Node 22/24 CI geçti. [PR #23](https://github.com/erolsenol/deploy-witness/pull/23) birleştirildi; [release workflow](https://github.com/erolsenol/deploy-witness/actions/runs/37202290552) başarılı. Immutable release commit `83bc0d00e729619de4b55f2b7d2b287484af6928`; npm latest 0.5.0, publisher erol.senol ve gitHead eşleşti. Tarball shasum `aa0713911a6b2e29ecb75bd0948e6ae17cfc7660`, registry integrity doğrulandı. Temiz npm consumer CLI/schema/report/JUnit/Markdown/public API smoke geçti. Yerel hesap yayını GitHub Actions provenance içermez; DW-16 canlı staging kapısı ayrı kalır.

Kapsam B2: CLI/Action ortak Markdown raporu ve güvenli report artifact yazımı.

1. DW-R19: Saf `renderMarkdown` reporter; metadata, required/optional, status ve failure code. Untrusted metin Markdown/HTML/table/control injection üretmez; raw evidence values eklenmez.
2. DW-R20: `verify` ve `report --markdown` ile Action summary aynı formatter'ı kullanır. Public API export, CLI/Action parity ve packed consumer kanıtı.
3. DW-R21: Artifact writer tüm çıktı yollarını yazmadan önce kontrol eder; kaynak config/report, alias/hardlink ve çift çıktı çakışmalarını reddeder. Symlink/non-regular çıktı reddi, aynı dizinde atomic rename ve 0600 izinleri. Birden çok çıktı için toplu transaction vaat edilmez; her dosya tek başına atomiktir.
4. DW-R22: Docs/version/bundle, 22/24 CI, GitHub immutable release, erol.senol npm ve temiz registry kurulumu.

Config v1/v2 ve report v1 alanları korunur. Remote deployment/provider mutation, yeni adapter ve gerçek staging kurulumu kapsam dışıdır. Geri dönüş 0.4.0 paket/Action pin referansıdır.

## Aktif release planı — 0.4.0 (2026-10-04)

**Durum:** Geliştirme tamamlandı; 216 test, lint/typecheck/schema/build/packed consumer ve npm audit (0 açık) geçti. [PR #22](https://github.com/erolsenol/deploy-witness/pull/22) birleştirildi. Main/development Node 22/24 CI ve [v0.4.0 release workflow](https://github.com/erolsenol/deploy-witness/actions/runs/37201435141) başarılı; GitHub release yayımlandı. Immutable release commit: `2a68570c7bd8f51ca03004583fcad6c578a1212d`. npm latest 0.4.0; publisher erol.senol, gitHead release commit ve integrity doğrulandı. Temiz registry consumer CLI/schema/report/JUnit/public API kontrolleri geçti; yerel hesap yayını provenance içermez.

Kapsam: B2 rapor tüketici ergonomisi. Kaydedilmiş report v1 dosyalarını provider tokenı/ağ çağrısı olmadan doğrulama, terminalde görüntüleme ve JUnit'e dönüştürme.

- DW-R16: Public `parseVerificationReport` ve `loadVerificationReport` API; strict v1 şeması, decision/check uyumu, unique IDs ve required check varlığı. UTF-8 ve 4 MiB sınırı, dosya büyümesine karşı bounded okuma, değer içermeyen hatalar.
- DW-R17: `report <path> --junit <path>` CLI; verify ile ortak terminal/exit code, kontrol karakteri temizleme. Tarihsel report örnekleri ve PASS/FAIL/INCOMPLETE kabul testleri.
- DW-R18: README, packed consumer, 0.4.0 version/bundle, lint/typecheck/schema/test/build/consumer, Node 22/24 CI, GitHub release ve erol.senol npm yayını.

Schema alanları değişmez. Çevrimdışı kontrol raporun imzasını, kaynağını, güncelliğini veya mevcut deployment durumunu doğrulamaz. Gerçek provider staging DW-16 ayrı kapıdır. Önceki 0.3.0 sürümü geri dönüş referansıdır; immutable tag ve npm sürümü değiştirilmez.

## Aktif release planı — 0.3.0 (2026-10-04)

**Güncel sonuç:** 0.3.0 geliştirme ve release tamamlandı. 199 test, lint/typecheck/schema/build/packed consumer ve dependency audit (0 açık) geçti. Development/main Node 22/24 CI ve [v0.3.0 release workflow](https://github.com/erolsenol/deploy-witness/actions/runs/37200159556) başarılı. [PR #21](https://github.com/erolsenol/deploy-witness/pull/21) birleştirildi; immutable release commit'i `817bae877ea80c458631f209416e271545adafce`. npm registry latest `0.3.0`, publisher `erol.senol`, gitHead release commit'i ve tarball checksum/integrity doğrulandı. Temiz registry install, CLI 0.3.0, config-v2 schema ve public concurrency/ID API smoke geçti. Yayın yerel hesap oturumuyla yapıldığı için GitHub Actions provenance yoktur. DW-16 gerçek staging kapısı ayrı/açık kalır.

Kapsam mevcut B3 runtime concurrency ve F release bakım işlerinin devamıdır. Önceki açık görevler korunur. 0.2.8 npm yayını `erol.senol` hesabıyla tamamlandı; GitHub'a taşınmamış metadata/workflow değişiklikleri bu release'e dahil edilir.

### Mimari kararlar

- Probe ID normalizasyonu tek saf fonksiyonda tutulur. Mevcut ID biçimi korunur; çakışan adlar config doğrulamasında reddedilir.
- Runtime worker sayısı varsayılan 4, aralık 1–20 olur. Kontrol CLI/Action/API çalışma seçeneğidir; config v1/v2 veya report v1 alanları değişmez. Kuyruktaki probe timeout'u probe başladığında başlar.
- İki provider ortak, boyut sınırlı stream okuyucu kullanır. 2 MiB sınırı chunk okunurken uygulanır, hata body'leri okunmadan iptal edilir. Provider'a özgü hata kodları ve mevcut deadline'lar korunur.
- npm yayıncı kimliği `erol.senol` olmalıdır. Yerel hesap yayını GitHub OIDC provenance üretmez; CI hesap-token yayını provenance desteğini korur ve NPM_TOKEN yoksa durur.

### Sıra ve kabul kapıları

1. DW-R12: ID çakışmalarını reddet; açıklama/çalışan/skipped check'leri aynı fonksiyonla üret. v1/v2, case/punctuation/truncation/fallback çakışmaları test edilir.
2. DW-R13: Sınırlı runtime worker'ları ve CLI/Action girdilerini ekle. Limit, sıra, provider failure skip, invalid girdide ağ çağrısı yapılmaması ve CLI/Action parity test edilir.
3. Checkpoint: Focused testler, typecheck ve schema drift kontrolü geçer.
4. DW-R14: Provider response stream sınırını uygula. Declared/chunked/UTF-8/exact-limit/invalid/truncated JSON ve cancellation/redaction testleri geçer.
5. DW-R15: Docs, migration, sürüm/bundle, Node 22/24 CI ve consumer smoke. Development üzerinden main release; immutable v0.3.0 tag, GitHub Release, npm `erol.senol` yayını ve temiz registry kurulumu doğrulanır.

### Sınırlar ve geri dönüş

DW-16 gerçek staging kabulü için dedicated non-production hedef gereklidir; bu release'in fixture testleri gerçek provider E2E olarak sunulmaz. Yeni provider veya attestation verifier bu sürüme eklenmez. Önceki npm sürümü `0.2.8`, önceki GitHub Action pin'i v0.2.6 SHA'sıdır; consumer sorununda bu referanslara dönülür, yayımlanan tag/sürüm değiştirilmez.


**Durum (2026-10-01):** `v0.2.7` GitHub Release ve npm yayını tamamlandı. PR #19 Node 22/24 CI’dan geçti; 136 test, build, consumer smoke ve dry-run başarılıydı. npm registry’de sürüm ve SLSA provenance görünür; temiz npm consumer kurulumu CLI `0.2.7` ve config v2 şemasını doğruladı. README Action örneği v0.2.6’in tam SHA’sına pinli ve GitLab CI tüketici örneği yayımlanan pakette. Tek açık MVP kabul kapısı gerçek staging E2E: DeployWitness non-production Coolify uygulaması/ayarları hâlâ yok; provider positive/negative kontrolleri çalıştırılmadı.
**Temel:** Public `erolsenol/deploy-witness`, güncel GitHub release `v0.2.7`.
**Hedef:** Tek bir sağlayıcı API sonucunu “uygulama kesin doğru sürümde” iddiasına dönüştürmeden; deployment kimliği, gerçek runtime davranışı ve isteğe bağlı build provenance kanıtlarını birleştiren güvenilir, kolay entegre edilebilir bir doğrulama aracı.

## Mevcut nokta

v0.2.6; Coolify ve Vercel read-only adapter’ları, HTTP probe’ları, strict config, TypeScript CLI, Node 24 GitHub Action, JSON/JUnit raporları ve Node 22/24 CI içeriyor. Kod, release ve npm tüketici kurulumu doğrulandı. Müşteri MVP kabulü için `tasks/todo.md` içindeki DW-16 gerçek staging E2E kanıtı hâlâ gerekiyor. Bu plan v0.2+ kapsamını ekler; `tasks/todo.md` MVP kabul kapılarını izler.

## Ürün hedefleri

1. “Deploy başarılı” sinyalini; beklenen source revision, deployment/resource, varsa image digest ve erişilebilir runtime kontrollerinden ayrıştır.
2. Her PASS kararında hangi kaynağın, hangi zamanda, hangi beklentiyi doğruladığını göster; eksik veya belirsiz kanıtı UNKNOWN/INCOMPLETE tut.
3. Kullanıcının 5–10 dakikada CLI veya GitHub Action ile başlamasını, aynı config ve core’u her iki yerde kullanmasını sağla.
4. Önce güvenlik, adapter sözleşmesi ve rapor uyumluluğunu oturt; yeni provider’ları bu kapıdan sonra ekle.
5. İşletim/deploy aksiyonu alma: doğrula, raporla, CI’ı başarısız kıl. Deploy, rollback, secret değiştirme ve uzaktaki sisteme yazma kapsam dışı.

## Ürün sınırları ve kararlar

- **Tek çekirdek, iki kullanım yüzeyi:** CLI ve JavaScript Action aynı core’dan karar üretir. Sonradan gerçek gereksinim doğmadan daemon, SaaS paneli veya çok paketli workspace kurulmaz.
- **Kanıt düzeyleri:** `provider` deployment kaydı, `runtime` HTTP probe ve `supply-chain` attestation kontrolleri ayrı kategorilerdir. Provider’ın “active” demesi runtime marker yerine geçmez; runtime 200 de commit/image kimliği kanıtı değildir.
- **PASS sözleşmesi:** Required kontrollerin tümü PASS olmadıkça genel sonuç PASS olmaz. UNKNOWN, UNSUPPORTED, SKIP, kanıt eskiliği ve timeout başarılı sayılmaz. WARN yalnızca açıkça optional kontrollerde raporlanır.
- **Backward compatibility:** Mevcut report schema v1 ve config v1 tüketicilerini koru. Yeni alanlar önce optional/additive; kırıcı değişim ancak schema v2 ve migration guide ile.
- **Güven sınırı:** API tokenı yalnızca provider’a gider. Probe’lara auth header aktarımı varsayılan olarak yoktur. Ham response gövdesi, sırlar ve token rapora/log’a yazılmaz.
- **Güvenilir egress:** Kullanıcı kontrollü URL’ler CI runner’ın ağ erişimini kötüye kullanabilir. Private/link-local IP, DNS rebinding ve IPv4-mapped IPv6 politikasını gerçek uygulama seviyesinde güvenceye almadan probe güvenli ilan edilmez. Sınır sağlanamayan runner ortamında kullanıcıya egress allowlist önerilir ve risk açıkça belgelenir.
- **Release güveni:** GitHub Action tüketicilerine tam commit SHA önerilir. npm dağıtımı için uzun ömürlü token yerine GitHub Actions trusted publishing/OIDC ve provenance hedeflenir; ilk npm package bootstrap’i hesap doğrulamasına bağlı ayrı adımdır.

## Mimari hedef

```text
CLI / GitHub Action
        │
        ▼
Config Loader ── Policy + Verification Orchestrator ── Report v1/v2
        │                  │             │                  │
        │                  ▼             ▼                  ▼
        │           Provider adapters   Runtime probes   JSON / terminal /
        │           Coolify, Vercel,    HTTP, stability   GitHub Summary, JUnit
        │           Railway (talebe göre)
        ▼
Secrets yalnızca process/env veya CI secret store içinde
```

Provider sözleşmesi küçük tutulur: `identifyResource`, `getDeployments`, `normalizeStatus`, `sourceRevision`, `imageDigest?`, `sourceTimestamp`, provider capability metadata. Adapter, sağlayıcının ham durumlarını ortak modele çevirir; policy kararını adapter vermez. Bir interface yalnızca en az iki adapter’ın ortak ihtiyacı doğrulamasıyla eklenir.

Raporun her check’i `id`, `category`, `status`, `required`, `summary`, `source`, `observedAt`, `expected`, redakte edilmiş `observed`, `failureCode`, `durationMs` ve ilgili resource/deployment/run korelasyonunu içerir. Secret veya tam response içeriği schema’da temsil edilemez. Rapor üst bilgisi tool/schema sürümü, expected commit/digest, resource tanımlayıcısı, başlangıç/bitiş zamanı ve decision policy sürümünü taşır.

## Fazlar ve sıra

### Faz A — Doğruluk ve güvenlik temeli (P0)

**A1. Kanıt sözleşmesi ve ADR**
- Mevcut v1 rapor örnekleri ve JSON Schema’yı yayınla.
- `PASS/FAIL/INCOMPLETE`, required/optional/WARN ve freshness anlamını örnek karar tablosuyla sabitle.
- Deployment korelasyonunu beklenen full SHA + doğru resource + çalışma penceresi + provider’ın aktif/latest semantiğiyle belirle. Yalnızca geçmişte herhangi bir eşleşen deployment bulundu diye PASS verme.
- Runtime marker için commit SHA ve OCI image digest biçimlerini ve bunların ayrı anlamını belge.
- **İlk dilim tamamlandı:** `started-after` sınırıyla eski deployment FAIL; sınır yoksa run correlation için optional WARN; sıralanamayan/missing `created_at` kaydı UNKNOWN.

**A2. Provider polling dayanıklılığı**
- Yalnızca idempotent GET isteklerinde sınırlı exponential backoff + jitter uygula; 429/5xx/network retry, 401/403/config hataları retry dışı.
- `Retry-After` delta-seconds ve HTTP-date biçimlerini oku; global deadline ve maksimum deneme sayısını aşma.
- AbortSignal/cancellation, her çağrıda timeout, pagination ceiling ve rate-limit telemetrisi ekle.
- Eksik/bozuk timestamp, pagination tekrarları, gecikmiş/stale kayıt ve aynı SHA için birden fazla deployment durumlarını fail-closed işle.

**A3. Probe güvenlik modeli**
- DNS sonucu IPv4/IPv6 tüm adreslerde public olmalı; loopback, private, link-local, multicast, unspecified ve metadata-service adreslerini reddet.
- DNS resolve ile socket bağlantısı arasındaki TOCTOU/DNS rebinding riskine karşı güvenli connect/lookup stratejisini kanıtla; kanıtlanamıyorsa feature’ı yalnızca explicit opt-in ve egress policy ile sun.
- HTTPS zorunluluğu, redirect kapalı varsayılanı, maksimum response bytes, header allow/deny listesi ve toplam çalışma deadline’ını koru.
- JSON parse, beklenmeyen encoding, content-type, gzip/stream limiti, özel IP literal ve IPv4-mapped IPv6 durumlarını kapsa.

**Checkpoint A:** v1 rapor geriye uyumludur; retry/status/freshness karar testleri geçer; URL koruması bağımsız test edilir; hiçbir kontrol belirsizlikte PASS üretmez.

### Faz B — Çekirdek ergonomisi ve politika (P1)

**B1. Config v1’i kullanılabilir kıl**
- Provider URL/resource/env anahtarları için belgeli env override önceliği ekle; değerleri diagnostic çıktıya basma.
- JSON Schema’yı CI’da üret/doğrula; YAML ve JSON config örnekleri aynı contract’tan geçsin.
- `config explain`/`verify --dry-run` config kaynağını ve planlanan kontrolleri değerleri redakte ederek göstersin.
- `init` mevcut dosyayı asla ezmesin; `--force` gerekiyorsa ayrı, açıkça onaylanan seçenek olsun.

**B2. Rapor ve CI çıktılarını zenginleştir**
- Terminal, JSON ve GitHub Step Summary aynı report modelinden üretilsin.
- **İlk dilim tamamlandı:** JUnit XML çıktısı GitHub dışı CI’larda her check’i test case olarak gösterebiliyor.
- JSON rapor dosya izinleri, artifact upload ve saklama süresi kullanıcı tarafından belirlenir; otomatik upload yok.
- Stable check ID, report schema version ve consumer migration örnekleri ekle.

**B3. Probe türleri ve deploy sonrası kararlılık**
- HTTP body’de sadece yapılandırılmış scalar JSON path/header eşitliğini değerlendir; response body raporlamayı hiçbir zaman ekleme.
- İsteğe bağlı bounded repeated checks (ör. N başarılı kontrol, minimum aralık ve toplam deadline) ile kısa süreli hazır olma dalgalanmasını tespit et.
- Latency threshold, TLS sertifika expiry veya DNS kontrolü ancak P0 güvenlik sınırları ve gerçek kullanım talebi varsa ayrı check türü olarak eklenir.
- Paralel probe concurrency limiti, stable ordering ve iptal davranışı tanımla.

**Checkpoint B:** CLI ve Action config/rapor kararı birebir aynıdır; JUnit/JSON sonuçları karşılaştırmalı testten geçer; örnek uygulama fixture’ı tek komutla çalışır.

### Faz C — Provider genişlemesi (P1, sözleşmeden sonra)

**C1. Ortak provider contract test paketi**
- Her adapter için status mapping, unknown state, pagination, auth failure, rate limit, stale deployment, wrong resource/SHA ve redaction testlerini zorunlu kıl.
- Provider capability alanları (source SHA, active deployment, digest, health) açıkça `supported/unsupported/unavailable` olarak raporlansın.
- Contract testleri ortak orchestrator’dan geçsin; test fixture’ları resmi doküman veya redakte edilmiş gerçek yanıt kaynaklı olsun.

**C2. Sıradaki adapter’lar**
- **Vercel:** İlk aday. Proje/team kapsamı, deployment state, git source SHA ve production/preview hedef ayrımını API’nin güncel resmi sözleşmesiyle doğrula.
- **Railway:** İkinci aday. `Active`, `Completed`, `Crashed`, `Removed` ve geçiş durumlarını ortak modele açıkça eşle; `Completed` her uygulamada başarılı servis anlamına gelmez.
- **Render:** Kullanıcı talebi/kurulum kanıtı çıkarsa sıraya al. Sağlayıcının deploy id, commit ve health sinyallerinin kapsamını doğrula.
- Her yeni adapter önce issue/ADR ve fixture contract ile kabul edilir. İlk iki adapter tamamlanmadan plugin marketplace/dynamic package loading yapılmaz.

**Checkpoint C:** En az iki adapter aynı senaryoları aynı common contract ile doğrular; provider-specific alanlar ve destek limitleri dokümante edilir.

### Faz D — Daha güçlü release identity (P2)

**D1. Image digest doğrulaması**
- `expectedImageDigest` ve provider tarafından gözlenen immutable `sha256:` digest’i rapor modeline ekle.
- Tag eşitliğini digest eşitliği yerine kabul etme.
- Runtime endpoint image/build marker verirse provider kaydından ayrı check üret; iki kaynak çelişirse FAIL/INCOMPLETE.
- Digest sağlamayan provider’da check `UNSUPPORTED` olur; config policy açıkça allow etmedikçe required image identity PASS olamaz.

**D2. Build provenance/attestation doğrulaması (opt-in)**
- GitHub Artifact Attestations/Sigstore için ayrı verifier adapter tasarla; expected repo, workflow identity, commit, subject digest ve trust root policy’sini doğrula.
- Attestation’ın “bu artifact nerede/nasıl üretildi” kanıtı olduğunu, “prod şu an bu artifact’i çalıştırıyor” kanıtı olmadığını rapor ve UI’da ayır.
- Attestation yok, yanlış repository/workflow, subject mismatch, imza veya zaman doğrulama hatası için açık failure code’lar ver.
- Varsayılan olarak `required: false`; kullanıcı policy ile zorunlu kılabilir.

**Checkpoint D:** Kaynak SHA → artifact digest → deployment digest → runtime marker zinciri ayrı kanıtlarda izlenir; tek bir zayıf sinyal güçlü kimlik iddiasına yükseltilmez.

### Faz E — GitHub ve diğer CI deneyimi (P2)

- Monorepo resource matrix örneği: her app/service için config profili ve ayrı run correlation.
- GitHub Action input/output isimleri ve stable exit code API’sini versionla; `GITHUB_TOKEN` için yalnızca gerçekten gereken izinleri iste.
- Üçüncü taraf Action kullanım örneklerini tam 40 karakter SHA ile pinle; fork PR’larında deploy token’ı erişilemez kıl.
- Opsiyonel GitHub Check Run/deployment status entegrasyonu ayrı izinli mod olsun; temel doğrulama token izni istemesin.
- GitLab CI/Azure Pipelines örnekleri CLI tabanlı olsun; özel connector yazmadan JSON/JUnit çıktıları kullanılabilsin.

**Checkpoint E:** Bir monorepo consumer ve bir GitHub dışı CI örneği secretsız mock hedefle uçtan uca doğrulanır.

### Faz F — Yayın ve bakım sistemi (P1, sürekli)

- npm package bootstrap’inden sonra npm Trusted Publishing (OIDC) ile tag-triggered yayın; release job’da ayrı permission scope ve protected environment kullan.
- Trusted publishing’den otomatik provenance, npm tarball integrity ve `gh attestation verify` rehberi.
- Release öncesi: temiz Node 22/24 install, CLI consumer smoke, action bundle kaynak-drift kontrolü, test, changelog ve tag aynı committe.
- Dependency review, Dependabot, secret scanning, CodeQL veya eşdeğer statik analiz, lisans/SBOM raporu ve minimal workflow permissions.
- Action major/minor tag yayın politikasını ve kullanıcıya full SHA tavsiyesini belge; tag’leri hareketli branch gibi kullanmayı teşvik etme.
- Destek matrisi, security response süreci, deprecation politikası, config/report migration rehberi ve issue template’leri.

## Önerilen release sırası

| Release | İçerik | Çıkış şartı |
|---|---|---|
| `0.1.x` | Coolify MVP ve güvenli read-only temel | P0 bug/security işleri, controlled staging doğrulaması |
| `0.2.0` | Report/config stabilizasyonu, retry ve JUnit | Faz A + Faz B checkpoint’leri |
| `0.3.0` | Vercel adapter; contract testleri | Faz C1 + C2 ilk provider |
| `0.4.0` | Railway adapter veya talep edilen alternatif | Ortak contract ve gerçek consumer kanıtı |
| `0.5.x` | Digest/provenance opt-in | Faz D threat model ve trust policy |
| `1.0.0` | Stabil public API/config/report | En az iki provider, migration policy, kullanım kanıtı, security/release kapıları |

Sürüm hedefleri takvim taahhüdü değildir; her sürüm kabul kapısına bağlıdır.

## Doğrulama stratejisi

- **Unit:** Decision table, status normalization, retry/deadline, backoff/Retry-After, config/env resolution, redaction ve serializers.
- **Contract:** Her provider adapter fixture’ı; sayfalama, unknown status, eski/yeni deployment, yanlış resource/commit/digest.
- **Network security:** Mocked resolver/socket veya kontrollü local server ile private IPv4/IPv6, mapped address, DNS rebinding sınırı, redirect, oversized/chunked/gzip body.
- **CLI/Action integration:** Geçici klasör, no-secret logs, exit code, summary escaping, cancellation, report format parity.
- **Consumer:** Packed tarball ve GitHub Action pinned SHA ile ayrı minimal örnek repo; build başarısı gerçek provider teslimatı sayılmaz.
- **Provider E2E:** Yalnızca dedicated staging app, least-privilege token, positive + negative controls. Production deployment/rollback yapılmaz.
- **Supply chain:** Tag’den oluşturulan gerçek release asset/paket provenance’ı CLI ile doğrulanır; sahte veya CI-only attestations başarı kanıtı sayılmaz.

## Başlıca riskler

| Risk | Düzey | Azaltma |
|---|---|---|
| Stale veya yanlış deployment seçimi | Yüksek | Full SHA + resource + run window + active/latest provider semantiği; stale fixtures |
| Probe URL ile runner SSRF | Yüksek | DNS/IP ve connect-time koruması, redirect kapalı, egress dokümantasyonu; test edilmeden güvenlik iddiası yok |
| Provider API drift’i | Orta | Resmi API referansı, fixtures, unknown state fail-closed, contract suite |
| Image/attestation sinyalini production state sanma | Yüksek | Her kanıt sınıfı ayrı; digest chain ve açık claim boundaries |
| Çok provider ile bakım yükü | Orta | Talep ve contract gate; aynı anda bir yeni adapter |
| Config/report değişikliğinin consumer kırması | Yüksek | Additive alanlar, schema versions, migration fixtures, semver |
| npm publish credential’ın sızması | Yüksek | Trusted Publisher OIDC, protected release environment, no long-lived write token |
| Gürültülü ve büyük raporlar | Orta | Size bounds, deterministic ordering, secret-free scalar evidence, user-controlled retention |

## Definition of Done — Her özellik

- Kabul ölçütleri ve failure/unknown durumları test edildi.
- Secret/PII redaction ve input/network abuse değerlendirildi.
- CLI ve Action aynı contract’ı kullanıyor; docs/example güncellendi.
- Raporlama `PASS` iddiasını ilgili kanıtın ötesine taşımıyor.
- Node 22/24 CI, lint, types, tests, build ve consumer smoke yeşil.
- Public yüzey değiştiyse schema/config/API versioning ve migration notu var.
- Provider E2E gerekiyorsa staging + negative control kanıtı ayrı belirtilmiş.

## Resmi teknik kaynaklar

- [GitHub Actions güvenli kullanım](https://docs.github.com/en/actions/reference/security/secure-use) — en az yetki ve Action’ları full-length commit SHA ile pinleme.
- [GitHub Artifact Attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations) — artifact provenance iddiaları ve doğrulama sınırları.
- [GitHub Attestation kullanımı](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) — workflow izinleri ve imzalı build provenance.
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) — GitHub Actions OIDC, uzun ömürlü token olmadan publish ve otomatik provenance gereksinimleri.
- [Coolify deployment API](https://coolify.io/docs/api/endpoints/deployments/list-deployments) — deployment alanları ve API yüzeyi.
- [Vercel REST API](https://vercel.com/docs/rest-api) ve [deployments](https://vercel.com/docs/deployments) — adapter tasarımından önce güncel API sözleşmesini doğrulama.
- [Railway deployment states](https://docs.railway.com/deployments/reference) — state semantiği; common status’a birebir string eşlemesi yapmama.

## Açık kararlar — uygulama öncesi

1. Vercel ilk yeni adapter olsun mu? Öneri: evet; API sözleşmesi ve kullanıcı geri bildirimi ile teyit ederek.
2. DNS rebinding’i uygulama düzeyinde engelleyen güvenli connect stratejisi sağlanamazsa public URL probe için external egress gateway mi, yoksa documented allowlist mi gereksinim olsun? Öneri: önce doğrudan güvenli resolver/connect kanıtı; yetersizse özellik sınırını daralt.
3. Provenance doğrulaması GitHub Artifact Attestations ile mi sınırlı başlasın? Öneri: evet, genel Sigstore/OCI trust framework’i sonradan.
