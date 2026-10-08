# DeployWitness — Açık Kaynak Dağıtım Kanıtı Aracı

> Ürün adı DeployWitness olarak kararlaştırıldı. Repository: `erolsenol/deploy-witness`; npm paketi: `deploy-witness` (yayın durumu README ve release notes üzerinden takip edilir).

> MVP sonrası geliştirme için öncelikli ve güncel yol haritası [`tasks/plan.md`](../tasks/plan.md); aşağıdaki belge ilk MVP kapsamının başlangıç planı ve teknik referansıdır.

## Amaç

CI işinin başarılı olması veya dağıtım API’sinin “başladı/tamamlandı” demesi uygulamanın doğru sürümünün kullanıcıya hizmet verdiğini tek başına kanıtlamaz. Proje; beklenen commit, sağlayıcının dağıtım kaydı ve gerçek HTTP davranışını tek bir denetlenebilir raporda birleştiren, önce Coolify + GitHub Actions için çalışan, daha sonra yeni dağıtım sağlayıcılarıyla genişleyebilen bir CLI ve GitHub Action sunar.

İlk sürüm salt-okunur doğrulama yapar. Dağıtım başlatmaz, iptal etmez, rollback yapmaz, ortama yazmaz. Çalıştıran workflow dağıtımı başlattıktan sonra DeployWitness gözlemler ve doğrular.

## Ürün ilkeleri

- **Kanıt türlerini ayır:** CI/build sonucu, sağlayıcı deployment kaydı, beklenen commit eşleşmesi ve public HTTP sağlığı ayrı kontroller olarak raporlanır.
- **Fail closed:** Kimlik doğrulama, sağlayıcı yanıtı, durum eşlemesi veya commit kanıtı anlaşılamıyorsa başarı uydurulmaz; sonuç UNKNOWN/FAIL olur.
- **Okunabilir gerekçe:** Her PASS/FAIL/WARN sonucu kullanılan kaynak, gözlenen değer ve eşik ile açıklanır.
- **Salt-okunur varsayılan:** Sağlayıcı adapter’ları MVP’de yalnızca sorgu yapar. Mutasyon komutları ürün kapsamı dışındadır.
- **Sırları koru:** Tokenlar log, rapor, hata mesajı veya GitHub output’una yazılmaz. Raporlara yalnızca secret olmayan kimlikler ve redakte edilmiş URL’ler girer.
- **Tek doğrulama motoru:** CLI, GitHub Action ve gelecekteki CI entegrasyonları aynı core kütüphaneyi kullanır.
- **Küçük, doğrulanabilir başlangıç:** İlk provider Coolify; ilk doğrulama kaynakları Coolify deployment API’si ve HTTP(S) endpoint kontrolüdür.

## MVP kullanıcı akışı

1. Kullanıcı CI içinde uygulamayı dağıtır.
2. Workflow beklenen commit SHA, Coolify host/token/resource UUID ve kontrol edilecek URL’leri DeployWitness’a verir.
3. Coolify adapter’ı ilgili uygulamanın en yeni deployment kayıtlarını salt-okunur biçimde sorgular ve hedef SHA’ya ait dağıtımın terminal durumunu bekler.
4. HTTP probe’ları `/health`, `/api/health` gibi kullanıcı tarafından belirlenen URL’leri kontrol eder.
5. DeployWitness adım özeti ve JSON raporu üretir; başarısız zorunlu kontroller workflow’u sıfır dışı kodla bitirir.

Varsayılan davranış deploy tetiklemek değil doğrulamaktır. Uygulama health endpoint’inde sürüm/commit bilgisi sunuyorsa kullanıcı bunu opsiyonel JSON path veya response header ile doğrulayabilir. Bu bilgi yoksa sadece gerçek API’nin ortaya koyduğu commit bilgisi raporlanır; HTTP 200 yanıtı “commit kesinlikle yayında” diye sunulmaz.

## Başarı sözleşmesi

Bir çalıştırma için PASS kararı ancak policy’deki tüm zorunlu kontroller kanıtlandıysa verilir:

1. Sağlayıcı kaydı doğru uygulama/resource için bulunur.
2. Deployment durumu dokümante edilmiş bir başarılı terminal durumuna eşlenir.
3. Provider commit alanı beklenen full SHA ile eşleşir; kısa SHA karşılaştırması kapalıdır.
4. Zorunlu HTTP kontrolleri eşik içinde başarılıdır.
5. İstenen sürüm işareti varsa response’tan okunan değer beklenen sürümle eşleşir.

Herhangi bir kontrol yapılandırılmamışsa SKIP olarak görünür. Sağlayıcı bunu desteklemiyorsa UNSUPPORTED olarak görünür. Bunlar PASS sayılmaz. Kullanıcı policy’de bazı kontrolleri opsiyonel uyarı yapabilir; varsayılan zorunlu kontrolleri sessizce düşürmek yasaktır.

## Mimari

### Çalışma alanı ve paketler

İlk public sürüm tek bir pnpm workspace monoreposu olarak planlanır. Paketler gerçek ayrım ve bağımsız yayın ihtiyacı oluşana kadar tek npm paketi içinde modüler klasörler olabilir; ilk günden çok sayıda küçük npm paketi çıkarılmaz.

- **src/contracts:** Zod şemaları ve public TypeScript tipleri: RunContext, CheckResult, Evidence, ProviderSnapshot, VerificationReport, policy/config.
- **src/core:** Saf doğrulama orkestrasyonu, policy değerlendirmesi, timeout/retry, sonuç normalizasyonu, redaction ve exit-code kararı. Sağlayıcı SDK/API bilgisi içermez.
- **src/providers/coolify:** Coolify REST API istemcisi ve deployment verisini ortak ProviderSnapshot’a dönüştüren adapter.
- **src/probes/http:** HTTP/HTTPS status, header, JSON path, TLS, timeout, redirect ve tekrar deneme kontrolü.
- **src/reporters:** Terminal, JSON ve GitHub Actions Step Summary/annotation çıktıları.
- **src/cli:** deploywitness verify, config validate, explain ve version komutları.
- **src/action:** GitHub Action girdilerini okur, CLI/core API’sini çağırır, GitHub output ve step summary yazar.
- **action.yml + dist:** Node 24 JavaScript Action; dağıtım için bundle edilmiş tek giriş dosyası. Güncel GitHub dokümanı node24 runtime’ını destekliyor.
- **examples:** Minimal Coolify workflow’u, çoklu endpoint örneği, monorepo resource örneği ve beklenen commit işareti örneği.

### Modül sınırları

Provider adapter sözleşmesi işlevsel olarak şunları sağlar: yetkiyi salt-okunur biçimde doğrulama, resource tanımını okuma, deployment listesini sorgulama, deployment durumunu gözlemleme ve ham sağlayıcı verisini güvenli ortak modele eşleme. Core yalnızca bu sözleşmeyi bilir. HTTP probes sağlayıcıdan bağımsız ayrı bir adapter’dır.

Provider yanıtındaki bilinmeyen enum/alanlar açıkça UNKNOWN/UNSUPPORTED olur. Coolify’ın status alanı API’de string olarak belgeleniyor; dolayısıyla tüm olası durum isimlerinin sabit olduğu varsayılmamalı. Parser, gözlenen fixture’larla ve resmi API sözleşmesiyle güncellenir.

### Rapor şeması

Rapor sürümlü JSON biçimine sahiptir:

- schemaVersion, toolVersion, runId, createdAt
- git: repository, ref, expectedSha, workflow/run URL (varsa)
- target: provider, resource alias/UUID (secret içermez)
- decision: PASS, FAIL veya INCOMPLETE
- checks: id, category, required, status, summary, durationMs
- evidence: source, observedAt, sanitized value, expected value, safe source URL
- failures: machine-readable code ve güvenli açıklama

Ham API cevapları, response body’leri, authorization header’ları ve tüm environment dump’ları rapora alınmaz. JSON Schema public olarak yayınlanır; minor sürümde geriye uyumlu genişletme, kırıcı alan değişiminde schema version yükseltmesi yapılır.

## Yapılandırma taslağı

Örnek config (gerçek secret dosyaya yazılmaz):

    version: 1
    provider: coolify
    coolify:
      baseUrl: https://deploy.example.com
      resourceUuid: ${{ vars.COOLIFY_RESOURCE_UUID }}
      token: ${{ secrets.COOLIFY_TOKEN }}
    deployment:
      expectedSha: ${{ github.sha }}
      timeoutSeconds: 600
    probes:
      - name: public-health
        url: https://app.example.com/api/health
        expectedStatus: 200
        timeoutMs: 5000
      - name: deployed-sha
        url: https://app.example.com/api/version
        jsonPath: commitSha
        expectedValue: ${{ github.sha }}
    report:
      jsonPath: deploywitness-report.json

Uygulama action input’ları ile YAML config arasında tek bir normalleştirme yolu olur. Secret’ın config içinde literal olarak tutulması engellenmezse bile README’de önerilmez; hata mesajları secret değerini asla göstermemelidir. MVP’de JSON/YAML config ve environment expansion yeterlidir; template motoru veya shell interpolation eklenmez.

## CLI ve Action UX

### CLI

- deploywitness init: örnek config üretir; mevcut dosyayı varsayılan olarak ezmez.
- deploywitness config validate: şema ve tutarlılık hatalarını satır/alan bazında açıklar.
- deploywitness verify: doğrulamayı çalıştırır; varsayılan terminal tablosu, opsiyonel JSON rapor.
- deploywitness explain <check-id>: kontrolün neyi kanıtladığını ve sınırlarını gösterir.
- Exit code 0: tüm zorunlu kontroller PASS; 1: doğrulanmış başarısızlık; 2: config/provider/auth/kanıt hatası; 3: kontrol süresi doldu. Kodlar dokümante edilir ve kararlı tutulur.

### GitHub Action

- Basit girişler: config-path, expected-sha, provider, Coolify URL/resource UUID, Coolify token, report-path.
- Token için workflow secret kullanımı; Action log’unda maskleme ve hata redaction.
- GitHub token varsayılan olarak istenmez. Gerekli olmadıkça permissions: contents: read sınırında kalır; id-token: write istenmez çünkü MVP harici OIDC/deploy yetkisi kullanmaz.
- Node 24 action runtime ve CI’de Node 22/24 uyumluluk matrisi; kullanıcı tarafındaki Action runtime GitHub’ın node24 desteğini kullanır.
- `continue-on-error` varsayılan çözüm değildir; opsiyonel kontroller policy ile WARN yapılır.
- Action input’larının PR içeriğinden gelebileceği varsayılır; shell’e eklenmez, güvenilmeyen değerler komut satırına interpolate edilmez.

## İlk sürüm dışı kapsam

- Coolify üzerinden deploy/rollback/cancel/migration çalıştırma.
- Coolify dışı sağlayıcılar. Sözleşme sonradan Render/Railway/Fly.io eklemeye izin verir; MVP’de adapter yazılmaz.
- Oturum açmalı kullanıcı akışları, ödeme veya gerçek iş işlemi tetikleme.
- Browser E2E, veritabanı yazma, production secret’larını çekme veya uygulamaya agent kurma.
- SaaS kontrol paneli, kullanıcı hesabı, merkezi rapor veritabanı, AI yorumlama.
- SBOM/SLSA attestations/signing. Önce JSON kanıtın semantiği ve integrity gereksinimi netleştirilir; sonra ayrı tasarım kararıyla eklenebilir.

## Aşamalı uygulama planı

### Aşama 0 — İsim, ürün sınırı ve sözleşme

1. **Tamamlandı:** Ürün adı DeployWitness olarak seçildi; repository/package metadata bu adla kuruldu.
2. README problem tanımını ve “ne kanıtlar / neyi kanıtlamaz” sınırlarını yayınlanabilir hâle getir.
3. Coolify API minimum izin, deployment listesi ve uygulamaya göre deployment sorgularını resmi API dokümanıyla doğrula.
4. PASS/FAIL/INCOMPLETE, zorunlu/opsiyonel kontroller ve JSON kanıt şemasını ADR ile dondur.

**Kapı:** İsim kararı, MVP public API, secret sınırları ve pass/fail contract yazılı; üretim API çağrısı yok.

### Aşama 1 — Repo temeli

1. **Tamamlandı (MVP):** TypeScript ESM, Node 22+ CLI/kütüphane, Node 24 Action runtime, strict TS ve Zod config validation. Başlangıç için tek npm paketi kullanılıyor; gereksiz workspace katmanı açılmadı.
2. Lisans (MIT önerisi), SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, issue/PR şablonları ve destek politikası.
3. CI: lint/format kontrolü, typecheck, birim/adapter testleri, build, paket tüketici smoke ve action bundle drift kontrolü.
4. Dependabot/Renovate, dependency review, minimum permissions, secret scanning ve immutable Action release tag rehberi.

**Kapı:** Temiz clone ile tek komut kurulum/build; Node matrisinde yeşil CI; secret yok; ilk örnek config schema’dan geçiyor.

### Aşama 2 — Çekirdek sözleşme ve salt-okunur Coolify doğrulaması

1. Ortak rapor ve check tipleri; terminal ve JSON serialize edilebilirlik.
2. Coolify HTTP client: base URL doğrulama, bearer auth, timeout, sınırlı retry, rate limit/401/403/5xx ayrımı.
3. Coolify application deployment adapter; resource UUID’ye göre kayıtları sorgula; full SHA ve terminal durumu eşle.
4. Provider durum geçişleri: pending/running durumlarını bekle; başarı, failure, cancelled, unknown ve timeout sonuçlarını ayır.
5. Sağlayıcı ham gövdesi ve token’ı rapora/log’a sızdırmayan redaction.

**Kapı:** Fixture tabanlı testler bütün durumları ve eksik/bozuk alanları kapsıyor; adapter gerçek deployment’ı değiştirmiyor.

### Aşama 3 — HTTP probe ve policy motoru

1. GET probe: timeout, beklenen status, TLS hatası ve güvenli redirect sınırı.
2. JSON path/header eşitliği ve beklenen deployment marker kontrolü.
3. Polling/backoff ve bütün çalışma süresi için global deadline; paralel probe’larda concurrency sınırı.
4. Kontrol bazlı required/warn policy, stabil check ID ve açık unsupported sonucu.
5. Credential forwarding kapalı: cross-origin redirect’e Authorization header taşınmaz; response body raporlanmaz.

**Kapı:** Status 200 tek başına beklenen sürümün kanıtı sayılmıyor; kullanıcı marker belirlediyse SHA/version eşleşmesi zorunlu.

### Aşama 4 — CLI ve yerel kullanım

1. `init`, `config validate`, `verify`, `explain`, `version` komutları.
2. Human terminal özeti, `--json`, `--report` çıktısı, exit code sözleşmesi.
3. Config ve env override önceliği; env key isimleri ve config source raporu (değerler olmadan).
4. Örnek app health endpoint sözleşmesi ve local mock-provider demo.

**Kapı:** Kullanıcı CI olmadan yerelde demo çalıştırıp raporu üretebiliyor; kötü config anlaşılır hatayla duruyor.

### Aşama 5 — GitHub Action ve monorepo örneği

1. Node 24 JavaScript Action; core ile aynı use case.
2. Step Summary, error/warning annotation, JSON artifact yolu ve output değişkenleri.
3. Örnek Coolify workflow: deploy adımından sonra bekle/doğrula; secret workflow environment’ından gelir.
4. Monorepo’da web/mobile-web/worker gibi ayrı resource’ları matrix ile doğrulama.
5. Untrusted PR senaryosu: fork PR’larında deployment secret erişimi ve workflow koşulları için güvenli örnek.

**Kapı:** Eylem tam SHA, doğru resource ve HTTP marker’ı doğrular; başarısız zorunlu kontrol workflow’u başarısız eder; action default permissions least privilege.

### Aşama 6 — Operasyon, güvenlik ve kalite

1. API/network timeout ve transient hata sınıflandırması mevcut. `Retry-After` başlığına uyum ve polling attempt sınırı sonraki sertleştirme işi.
2. SSRF/URL guard: HTTPS varsayılan; localhost yalnızca açık local-dev seçeneğiyle; link-local/private ağ erişimi için kullanıcının açıkça tanımladığı sınır.
3. Log/report redaction testleri; kötü niyetli URL, header, response ve config girdileri.
4. CLI/action contract testleri, provider fixture’ları, fake clock ve local HTTP server ile deterministic testler.
5. README quickstart, örnek workflow’lar, provider limitations, threat model, troubleshooting ve JSON schema dokümanı.

**Kapı:** Secret scanning, dependency audit, kalite kontrolleri ve clean-consumer kurulum geçer; başarı/başarısızlık örnekleri dokümanda gösterilir.

### Aşama 7 — Public beta ve genişleme

1. GitHub repo ve v0.1.0 beta release hazırlığı.
2. Kendi Coolify staging hedefinde dry-run ve controlled live verification; rapor, API rate ve yanlış pozitifleri gözlemle.
3. Kullanıcı geri bildirimiyle check sözleşmesini sabitle; provider ekleme rehberi yayınla.
4. Sonraki adapter’ı ancak aynı ortak sözleşme ve gerçek kullanıcı talebi varsa ekle.
5. Stabil kullanım sonrası v1.0 semver garantisi, JSON schema version ve deprecation politikası.

**Kapı:** Paketin GitHub Action ve CLI ile bağımsız consumer reposunda kurulup çalıştığı doğrulandı; “deploy oldu” iddiası provider + public target kanıtına bağlı.

## Başlangıç repo yapısı

    .github/workflows/
    docs/adr/
    docs/providers/
    examples/coolify-basic/
    examples/coolify-monorepo/
    schemas/
    src/contracts/
    src/core/
    src/providers/coolify/
    src/probes/http/
    src/reporters/
    src/cli/
    src/action/
    tests/fixtures/coolify/

Paket sınırları ileride npm’de ayrı dağıtım veya farklı release ritmi gerektirdiğinde workspace paketlerine çıkarılır. İlk aşamada modülerlik klasör ve interface düzeyinde tutulur.

## Temel doğrulama matrisi

- Coolify deployment bulunamadı, pending, running, başarılı, failed, cancelled, unknown status.
- Yanlış resource, yanlış/eksik commit SHA, provider pagination/rate limit, 401/403, 5xx, timeout.
- HTTP status doğru/yanlış, TLS invalid, DNS/network fail, timeout, redirect, marker doğru/yanlış, invalid JSON.
- Eksik optional provider field, response body içinde secret benzeri metin, auth header içeren hata.
- Config unknown key, type mismatch, path/env interpolation, timeout sınırı, URL private IP guard.
- Action fork PR, secret maskleme, summary escaping, multiline command injection girdisi, non-zero exit mapping.

## Riskler ve azaltma

| Risk | Etki | Önlem |
|---|---|---|
| İsim çakışması | Arama bulunabilirliği/marka karışıklığı | Repo açmadan önce GitHub/npm/domain ve marka kontrolü; özgün ad seçimi |
| Coolify API sürüm/status drift’i | Yanlış PASS/FAIL | Dokümante alanlar, fixture seti, unknown status fail-closed, API uyumluluk notu |
| Provider kaydı commit’le eşleşiyor ama edge eski sürüm sunuyor | Sahte release güveni | Provider ve gerçek HTTP marker ayrı kontroller; marker yoksa raporda kanıt sınırı açık |
| Action token sızıntısı | Deployment API erişiminin ele geçmesi | Masking/redaction, hiçbir raw response kaydetmeme, least privilege ve security tests |
| Public URL probe üzerinden SSRF | Runner’ın iç ağa erişmesi | URL/redirect guard, private IP politikasını açıkça uygulama, hiçbir shell çağrısı yapmama |
| Fazla provider ile MVP’nin büyümesi | İlk sürüm gecikmesi | Coolify + HTTP ile başla; adapter API’sini soyutla ama adapter sayısını artırma |
| Güvenlik kanıtı iddiasını abartma | Kullanıcı yanıltılır | README ve raporda “ne kanıtlar/ne kanıtlamaz” alanı, imza/attestation’ı ayrı faza bırakma |

## İlk sürüm tamamlanma tanımı

- Kullanıcı 10 dakikadan kısa sürede example workflow’u kendi Coolify resource’una uyarlayabilir.
- Aynı check engine CLI ve GitHub Action’dan çağrılır.
- Beklenen SHA, Coolify terminal durumu ve public endpoint zorunlu kontrolleri tek JSON raporda ayrı kanıtlarla görünür.
- Zorunlu check başarısız/unknown/timeout ise exit code sıfır değildir.
- Token ve response body hiçbir output/report/log’da görünmez.
- README desteklenen runtime, minimum Coolify/API beklentisi, permission ihtiyacı, sınırlamalar ve örnek troubleshooting içerir.
- CI lint, typecheck, tests, build, action bundle consistency ve packed consumer doğrulamasını çalıştırır.
- README’den npm kurulumuna veya full SHA ile GitHub Action kullanımına giden yol çalışır.

## Araştırma kaynakları

- [Coolify API genel bakış](https://coolify.io/docs/api/overview) — self-hosted base URL, API token, endpoint ve health check.
- [Coolify uygulama deployment’larını listeleme](https://coolify.io/docs/api/endpoints/deployments/list-deployments-by-app-uuid) — uygulama bazlı deployment verisi.
- [Coolify deployment API](https://coolify.io/docs/api/endpoints/deployments/list-deployments) — status, commit, UUID ve deployment metadata alanları.
- [Coolify otomatik deployment ve doğrulama](https://coolify.io/docs/applications/deployments/automatic-deployments) — deployment kaydı, branch ve watch-path davranışı.
- [GitHub JavaScript Action oluşturma](https://docs.github.com/en/actions/tutorials/create-actions/create-a-javascript-action) — node24 runtime ve dağıtılabilir bundle.
- [GitHub OIDC güvenlik modeli](https://docs.github.com/en/actions/reference/security/oidc) — Action izinleri. MVP token ile read-only Coolify API kullanır; OIDC izni istemez.
- [İsim çakışması örneği](https://deploywitness.de/) — DeployWitness adı Jira release readiness ürününde kullanılıyor.

## Açık kararlar

1. İsim kararı DeployWitness olarak verildi; ürün yüzeyleri bu adla ortaklaştırıldı.
2. İlk sürüm CLI + aynı core'u kullanan GitHub Action olarak planlanıyor; npm yayını release/provenance kapısından sonra yapılacak.
3. Coolify MVP için minimum desteklenen sürüm, gerçek instance’da endpoint/status doğrulamasından sonra belirlenmeli; şu aşamada sürüm uydurulmamalı.
4. İlk sürümde public endpoint probe’ları hangi subnet/host policy’yle çalışacak? Güvenli varsayılan HTTPS + public IP; local test opt-in olabilir.
