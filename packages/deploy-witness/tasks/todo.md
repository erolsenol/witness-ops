# DeployWitness — Uygulama Görev Listesi

## Aktif 0.3.0 release görevleri (2026-10-04)

### DW-R12: Probe check kimlikleri

**İş:** ID üretimini ortaklaştır ve çakışmaları config validation sırasında reddet.
**Kabul:** Aynı check ID'yi üreten adlar v1/v2 için reddedilir; explain/runtime/skipped sonuçlar aynı ID'yi kullanır.
**Doğrulama:** Config ve core regression testleri, schema:check.
**Bağımlılık:** Mevcut config/report sözleşmesi. **Boyut:** M.
- [x] Ortak ID ve collision validation tamamlandı.
- [x] Boundary/regression testleri geçti.

### DW-R13: Runtime probe concurrency

**İş:** Default 4, 1–20 worker sınırı; CLI --probe-concurrency, Action probe-concurrency ve Node API seçeneği.
**Kabul:** Aktif probe sayısı limiti aşmaz; sıra korunur; invalid input provider çağrısından önce reddedilir; başarısız provider probe başlatmaz.
**Doğrulama:** Deterministic scheduler testleri, CLI/Action yerel fixture parity.
**Bağımlılık:** DW-R12. **Boyut:** M (core ve yüzey entegrasyonu ayrı dilimler).
- [x] Core bounded concurrency ve input validation tamamlandı.
- [x] CLI/Action entegrasyonu ve testler geçti.

### Checkpoint 0.3.0 core
- [x] Focused testler, typecheck ve config/report schema drift kontrolü geçti.

### DW-R14: Bounded provider response streaming

**İş:** Coolify/Vercel JSON body'lerini ortak 2 MiB stream sınırıyla oku; hata body'lerini iptal et.
**Kabul:** Declared ve chunked oversized body erken iptal edilir; byte sınırı exact-limit ve UTF-8 için doğrudur; truncated/invalid response başarısız olur; response/token içeriği hata veya rapora taşınmaz.
**Doğrulama:** Reader unit ve her provider client contract testleri.
**Bağımlılık:** Yok. **Boyut:** M.
- [x] Bounded reader ve client entegrasyonu tamamlandı.
- [x] Sınır, stream failure, cancellation ve redaction testleri geçti.

### DW-R15: 0.3.0 release

**İş:** Docs, changelog, sürüm ve Action bundle'ı güncelle; development/main, GitHub Release ve npm yayını tamamla.
**Kabul:** Node 22/24 CI, full checks, packed/registry consumer geçer; tag aynı release commit'indedir; latest npm publisher erol.senol olur.
**Doğrulama:** Remote SHA, terminal CI/release job, npm metadata ve temiz kurulum. Yerel npm yayınında GitHub OIDC provenance beklenmez.
**Bağımlılık:** DW-R12–R14. **Boyut:** M.
- [x] Dokümantasyon ve release metadata/bundle tamamlandı.
- [x] Development/main CI ve GitHub Release geçti.
- [x] npm publisher, latest, integrity ve registry consumer doğrulandı.


> Progress update (2026-10-01): GitHub Release and npm package `v0.2.7` are public from release commit `ba87b76`. PR #19 Node 22/24 CI and Release/npm Trusted Publishing workflows passed; 136 tests, build, packed consumer smoke, and dry-run passed. npm metadata exposes SLSA provenance, and a clean registry install verified CLI `0.2.7` and config v2 schema. README pins the GitHub Action to the full v0.2.6 commit SHA; a GitLab CI deploy/verify example is included in the npm tarball. The manual Coolify staging workflow requires explicit non-production confirmation and covers positive/wrong-SHA/wrong-marker cases, report schema, and token redaction. Live staging has not run because no non-production app or staging settings are available; MVP staging acceptance remains open.

Bu liste plan onaylandıktan sonra uygulama sırasıdır. Her görev ayrı ve gözden geçirilebilir bir dilim olarak bitirilir; geniş görevler alt görevlere bölünür.

## Faz 0 — Ürün sözleşmesi

### DW-01: Proje adını ve public kapsamı kesinleştir

**İş:** Ürün adı DeployWitness olarak kararlaştırıldı; repo, npm, GitHub Action ve metadata yüzeylerinde ortaklaştır.

**Kabul ölçütleri:**
- [x] Ürün adı DeployWitness olarak kararlaştırıldı ve proje metadata'sına işlendi.
- [ ] Repo slug, package scope, CLI binary ve Action adı kararlı biçimde seçilmiş.
- [ ] README one-liner, neyi kanıtladığını ve sınırlamalarını anlatıyor.

**Doğrulama:** GitHub/npm adı önceki araştırmada müsaitti; public repo oluşturma sırasında tekrar doğrulanacak.
**Bağımlılık:** Yok.
**Boyut:** S.

### DW-02: JSON kanıt modeli ve karar kurallarını dondur

**İş:** Check status’ları, required/warn davranışı, failure code’ları, rapor versioning ve PASS kararının koşullarını tanımla.

**Kabul ölçütleri:**
- [ ] PASS sadece bütün zorunlu kanıtlar doğruysa mümkün.
- [ ] UNKNOWN, UNSUPPORTED, SKIP, WARN ve FAIL birbirinden ayrılıyor.
- [ ] Örnek başarılı/başarısız rapor ve JSON Schema dokümante edilmiş.

**Doğrulama:** Şema örnekleri valid; decision contract örnek vakalarda beklenen kararı üretiyor.
**Bağımlılık:** DW-01.
**Boyut:** M.

### DW-03: Coolify API yetki ve uyumluluk matrisi

**İş:** Uygulama deployment listesi/status/commit endpoint’lerini ve minimum salt-okunur izinleri resmi docs ve uygun test ortamında doğrula.

**Kabul ölçütleri:**
- [ ] Token kapsamı en az gerekli izinle belgelenmiş.
- [ ] Desteklenen deployment alanları, pagination ve geçerli status değerleri fixture’larla kayıtlı.
- [ ] Bilinmeyen status ve eksik SHA davranışı açıkça fail-closed.

**Doğrulama:** Resmi doküman referansı ve redakte edilmiş örnek yanıtlar.
**Bağımlılık:** DW-02.
**Boyut:** M.

## Faz 1 — Repo temeli

### DW-04: TypeScript workspace ve kalite kapılarını kur

**İş:** Strict TypeScript, ESM, workspace, lint/format, test runner, build ve Node matrix CI’sini ekle.

**Kabul ölçütleri:**
- [ ] Temiz clone’da tek dokümante kurulum komutu çalışıyor.
- [ ] CI lint, typecheck, tests ve build yapıyor.
- [ ] Node runtime aralığı ve action runtime ayrı ve belgeli.

**Doğrulama:** CI Node 22/24 build/typecheck; package manager lock temiz.
**Bağımlılık:** DW-01.
**Boyut:** M.

### DW-05: Public repo yönetişimi ve güvenlik politikası

**İş:** Lisans, README, SECURITY.md, CONTRIBUTING.md, Code of Conduct, issue/PR şablonları ve dependabot ekle.

**Kabul ölçütleri:**
- [ ] Lisans dosyası ve paket metadata eşleşiyor.
- [ ] Güvenlik bildirimi kanalı ve desteklenen sürüm politikası açıklanmış.
- [ ] CI izinleri minimumda; bağımlılık güncellemeleri kontrollü.

**Doğrulama:** Repo metadata denetimi, link ve workflow permission review.
**Bağımlılık:** DW-04.
**Boyut:** M.

## Faz 2 — İlk doğrulama dilimi

### DW-06: Coolify read-only istemci ve hata modeli

**İş:** Bearer auth, HTTPS, timeout, request-id, API hata sınıflandırması ve redaction içeren minimal istemci oluştur.

**Kabul ölçütleri:**
- [ ] Her istek deadline ve response size sınırıyla çalışıyor.
- [ ] 401/403, rate limit, 5xx, network ve invalid JSON farklı failure code veriyor.
- [ ] Token hiçbir error/log/test snapshot’ında görünmüyor.

**Doğrulama:** Stub server testleri; unauthorized ve malformed responses.
**Bağımlılık:** DW-03, DW-04.
**Boyut:** M.

### DW-07: Coolify deployment adapter

**İş:** Uygulamanın deployment kayıtlarını ortak ProviderSnapshot modeline eşle ve hedef SHA’ya ait son dağıtımı bul.

**Kabul ölçütleri:**
- [ ] Full SHA eşleşmesi yapılır; short SHA başarı sayılmaz.
- [ ] Pending/running beklenir; başarılı/failure/cancelled/unknown açık sonuç verir.
- [ ] API ham body’si kullanıcı raporuna aktarılmaz.

**Doğrulama:** Her status, no deployment, wrong SHA ve missing field fixture testleri.
**Bağımlılık:** DW-02, DW-06.
**Boyut:** M.

### DW-08: Doğrulama orkestrasyonu ve rapor üretimi

**İş:** Provider check’lerini ortak check modelinde çalıştır, karar ver ve sürümlü JSON/terminal raporu oluştur.

**Kabul ölçütleri:**
- [ ] Check sonucu source/observedAt/expected/observed ile ilişkilendirilir.
- [ ] Sırlar ve raw response alanları schema tarafından dışlanır.
- [ ] Zorunlu unknown/timeout PASS üretemez.

**Doğrulama:** Karar tablosu testleri ve snapshot olmayan stabil JSON assertions.
**Bağımlılık:** DW-02, DW-07.
**Boyut:** M.

**Kontrol noktası:** DW-08 sonunda yalnızca Coolify deployment kaydıyla doğrulama çalışan yerel bir dikey dilim tamamlanmış olur.

## Faz 3 — Dış runtime doğrulaması

### DW-09: HTTP health probe

**İş:** Status, response header, JSON path, TLS/DNS, timeout ve marker eşitliği kontrollerini sağlayıcıdan bağımsız ekle.

**Kabul ölçütleri:**
- [ ] Status 200 ile deployment SHA kanıtı birbirine karıştırılmaz.
- [ ] Redirect sonrası auth header başka origin’e aktarılmaz.
- [ ] Required/warn policy ve per-probe timeout çalışır.

**Doğrulama:** Local HTTP server ile 2xx/4xx/5xx, redirect, timeout, TLS ve marker senaryoları.
**Bağımlılık:** DW-08.
**Boyut:** M.

### DW-10: URL güvenlik sınırları

**İş:** URL parse/host validation, private network politikası, response size ve redirect limitlerini tanımla.

**Kabul ölçütleri:**
- [ ] HTTPS varsayılan; localhost sadece açık local-development flag’iyle.
- [ ] Link-local/private IP ve redirect politikası açıkça uygulanır.
- [ ] URL/header injection girdileri shell veya GitHub command olarak yürütülmez.

**Doğrulama:** IPv4/IPv6 internal adres, DNS rebind sınırları için tasarım incelemesi, redirect chain ve oversized response testleri.
**Bağımlılık:** DW-09.
**Boyut:** M.

## Faz 4 — Kullanım yüzeyleri

### DW-11: Config şeması, env resolution ve init

**İş:** YAML/JSON config, Zod validation, env var expansion ve dosya oluşturan init komutunu ekle.

**Kabul ölçütleri:**
- [ ] Unknown key ve yanlış tip alan bazında gösteriliyor.
- [ ] Secret değerleri config dump/diagnostic çıktısında gizli.
- [ ] init mevcut config’i varsayılan olarak ezmiyor.

**Doğrulama:** Valid/invalid config örnekleri ve overwrite guard.
**Bağımlılık:** DW-02, DW-09.
**Boyut:** M.

### DW-12: CLI komutları ve exit-code API

**İş:** init, config validate, verify, explain, version, json/report format seçeneklerini sun.

**Kabul ölçütleri:**
- [ ] PASS, verification fail, config/provider failure ve timeout exit code’ları belgeli ve stabil.
- [ ] CLI offline config validation yapabilir.
- [ ] Human ve JSON rapor aynı decision/check sonuçlarına dayanır.

**Doğrulama:** CLI integration tests, help output ve packed consumer smoke.
**Bağımlılık:** DW-08, DW-11.
**Boyut:** M.

### DW-13: Node 24 GitHub Action

**İş:** action.yml, input/output contract, Action Toolkit integration, summary ve annotation ekle.

**Kabul ölçütleri:**
- [ ] Action aynı core çağrısını kullanır; ikinci bir decision motoru yok.
- [ ] GitHub token varsayılanı gerekmez; minimum izinler ve token maskleme uygulanır.
- [ ] Başarısız required check workflow adımını başarısız bitirir.

**Doğrulama:** action test harness, workflow fixture ve step summary escaping testleri.
**Bağımlılık:** DW-12.
**Boyut:** M.

### DW-14: Action bundle ve release tag akışı

**İş:** Node action bundle üretimi, generated dist kontrolü ve SHA pin’li release rehberi.

**Kabul ölçütleri:**
- [ ] CI bundle’ın kaynakla güncel olduğunu doğrular.
- [ ] Action `uses: owner/repo@<full-sha>` örneği sunar.
- [ ] GitHub release tag’i immutable action referansı sağlar.

**Doğrulama:** Clean checkout bundle/build ve örnek consumer workflow.
**Bağımlılık:** DW-13.
**Boyut:** S.

## Faz 5 — Public beta ve gerçek hedefte kanıt

### DW-15: Quickstart ve Coolify örnekleri

**İş:** Basic app, sürüm endpoint’i ve monorepo resource matrix için uçtan uca doküman/example yaz.

**Kabul ölçütleri:**
- [ ] İlk kurulum 10 dakikada tamamlanabilir.
- [ ] Coolify token ve resource UUID ayarları least-privilege açıklamasıyla gösterilir.
- [ ] Provider/HTTP/marker kanıtlarının ayrı anlamları dokümante edilir.

**Doğrulama:** Örnek workflow YAML validation ve clean repo install walkthrough.
**Bağımlılık:** DW-13, DW-14.
**Boyut:** M.

### DW-16: DeployWitness’u kendi staging uygulamasında çalıştır

**İş:** Önce non-production Coolify uygulaması ve health marker ile controlled end-to-end doğrulama yap.

**Kabul ölçütleri:**
- [ ] Beklenen SHA eşleşmesi ve kasıtlı yanlış SHA failure’ı gözlemlenmiş.
- [ ] App healthy ama marker yanlış senaryosu PASS vermiyor.
- [ ] Token/PII rapora çıkmıyor; rapor JSON şemaya uyuyor.

**Doğrulama:** Redakte edilmiş staging raporu, GitHub Actions run linki ve negative control kanıtı.
**Bağımlılık:** DW-15.
**Boyut:** M.

### DW-17: npm paket bootstrap’i ve beta release kanıtı

**İş:** Public repo, npm package ve GitHub Action release’i yayınla; provider genişleme talebini issue template ile topla.

**Kabul ölçütleri:**
- [x] README npm install ve full-SHA Action kurulumunu içerir.
- [x] npm tarball yalnızca runtime dosyaları, lisans ve gerekli dokümanları içerir.
- [x] Changelog, desteklenen runtime, semver ve deprecation politikası var.

**Doğrulama:** npm registry’den temiz consumer install ve provenance, public CI; GitHub Action gerçek provider çalıştırması DW-16 staging kabul kapısında.
**Bağımlılık:** DW-16.
**Boyut:** M.

## İleriki sürüm adayları — MVP tamamlandıktan sonra

- Render/Railway/Fly.io gibi provider adapter’ları (yalnızca istenen ve belgelenmiş API’lerle).
- GitHub deployment status/check-run entegrasyonu, gerekirse isteğe bağlı izinle.
- Önceki/sonraki deploy diff’i ve rollback target kanıtı (rollback icra etmeden).
- Attestation/provenance; önce tehdit modeli ve trust root belirlenerek.
- Policy custom check plug-in sözleşmesi, sadece iki gerçek adapter bunu haklı çıkardığında.

Her adapter için acceptance standardı: API sözleşmesi kaynaklı fixture’lar, status coverage, commit identity, failure/unknown handling, token redaction, dokümante minimum permissions ve kendi consumer örneği.

## DeployWitness 0.2+ genişletme planı

Detaylı mimari, scope, güvenlik modeli ve release kapıları [`tasks/plan.md`](plan.md) dosyasındadır. Aşağıdaki işler mevcut unchecked MVP görevlerini silmez veya tamamlanmış saymaz; MVP sonrası eklenti roadmap’idir.

### DW-R01: Kanıt sözleşmesi ve freshness/correlation ADR

**İş:** Report v1 uyumluluğunu koruyarak deployment kimliği, run window, source freshness, digest ve decision policy semantiğini yazılı dondur.

**Kabul ölçütleri:**
- [x] PASS/FAIL/INCOMPLETE ve required/optional/WARN karar matrisi yayınlanır.
- [x] Her kanıt sınıfının neyi kanıtlamadığı örnek raporla gösterilir.
- [x] Verilen run-start sınırından eski deployment PASS üretemez; sınır yoksa rapor korelasyon eksikliğini WARN olarak açıklar.

**Doğrulama:** JSON Schema ve rapor örnekleri doğrulanır; report v1 consumer fixture’ları korunur.
**Bağımlılık:** Mevcut report/config v1 incelemesi.
**Boyut:** M.

**İlerleme:** `docs/adr/0001-evidence-and-freshness-v1.md` report v1 karar matrisini, run-start korelasyon sınırlarını ve her kanıtın neyi kanıtlamadığını tanımlıyor. Üç yayımlanabilir JSON rapor örneği şemaya karşı test ediliyor; mevcut core testleri stale deployment'ın FAIL ve boundary yokluğunun optional WARN olduğunu doğruluyor.

### DW-R02: Coolify polling dayanıklılığı

**İş:** Retry-After, sınırlı backoff/jitter, global deadline, cancellation ve bounded pagination ekle.

**Kabul ölçütleri:**
- [x] Yalnızca idempotent transient GET hataları retry edilir; auth/config hataları edilmez.
- [x] Retry-After ve toplam deadline/maksimum deneme sınırları uygulanır.
- [x] Supplied run boundary’den eski, missing timestamp veya newest timestamp tie deployment UNKNOWN/FAIL olur, PASS değil.

**Doğrulama:** Fake clock, kontrollü fetch ve Retry-After delta/date fixture’larıyla deterministik testler.
**Bağımlılık:** DW-R01.
**Boyut:** M.

### DW-R03: HTTP probe SSRF ve network sınırı

**İş:** Public URL probe’larında DNS/IP ve connect-time güvenliğini, IPv4/IPv6 dahil, gerçekçi biçimde uygula.

**Kabul ölçütleri:**
- [x] Private, loopback, link-local, metadata, multicast ve mapped-IP blokları reddedilir.
- [x] DNS rebinding/TOCTOU savunması testle doğrulanır: tüm DNS cevapları kontrol edilir ve soket doğrulanmış IP’ye pinlenir.
- [x] Redirect kapalı, response byte limiti, timeout ve secret/body redaction korunur.

**Doğrulama:** DNS/resolver sınırları, IPv4/IPv6 edge case’ler, redirects ve oversized stream testleri; threat-model incelemesi.
**Bağımlılık:** DW-R01.
**Boyut:** L (alt görevlere bölünerek uygulanacak).

### DW-R04: Config ergonomisi ve report consumer contract

**İş:** Env override önceliği, config explain/dry-run, JSON Schema çıktısı ve JUnit formatter ekle.

**Kabul ölçütleri:**
- [x] Config açıklaması değerleri ve sırları yazdırmadan kaynak/override sırasını gösterir.
- [x] JUnit ve JSON check kimliğini ve CI kararına denk sonucu korur; rapor kararı JUnit property alanında yer alır.
- [x] Sürümlü config/report JSON Schema dosyaları runtime sözleşmelerinden üretilir ve CI'da drift açısından denetlenir.
- [x] Report v1 ve config v1 tüketicileri için migration sınırları testlidir; unknown report fields artık runtime schema tarafından da reddedilir ve version bump gereksinimi README'de belgelenmiştir.

**Doğrulama:** CLI integration + format parity testleri ve packed consumer smoke.
**Bağımlılık:** DW-R01.
**Boyut:** M.

**Checkpoint R1:** DW-R01–R04 tamamlandığında Coolify ve HTTP probe yanlış PASS riskleri kapatılmış, rapor tüketicileri için geriye uyum korunmuş olmalı.

### DW-R05: Provider contract test suite

**İş:** Adapter status, pagination, identity, rate-limit ve redaction davranışlarını ortak test arayüzüne taşı.

**Kabul ölçütleri:**
- [x] Capability support/unsupported/unavailable açıkça raporlanır.
- [x] Her adapter aynı unknown, stale, wrong SHA/resource ve auth senaryolarını geçirir.
- [x] Adapter karar motoru içermez; yalnızca provider verisini normalize eder.

**İlerleme:** `tests/provider-contract.test.ts` Coolify ve Vercel için başarı, SHA uyuşmazlığı, bilinmeyen durum, eksik commit, stale deployment, configured resource scope ve auth/redaction senaryolarını aynı kabul suite’inde çalıştırıyor. Coolify resource UUID’yi route seviyesinde uygular; Vercel farklı project ID dönerse FAIL verir. Provider testleri Coolify skip/take sayfalarını, Vercel `pagination.next`/`until` cursor'unu, rate-limit ve secret redaction davranışını doğruluyor. Rapor seviyesinde capability inventory eklendi; API erişilemezse desteklenen capability `UNAVAILABLE` raporlanıyor. Her iki adapter ortak deployment evidence evaluator’ını kullanıyor.

**Doğrulama:** Ortak fixture suite’i iki adapter’da aynı karar kurallarını doğrular; fixture’lar test içinde sentetik HTTP yanıtlarıdır, gerçek provider E2E değildir.
**Bağımlılık:** DW-R01, DW-R02.
**Boyut:** M.

### DW-R06: Vercel provider adapter

**İş:** Resmi API sözleşmesi doğrulandıktan sonra Vercel project/team deployment doğrulamasını ekle.

**Kabul ölçütleri:**
- [x] Preview/production target, project/team scope, deployment state ve full commit SHA ayrı kanıttır.
- [x] Bilinmeyen API state ve eksik commit PASS olmaz.
- [x] Minimum token erişimi ve secret kullanımı dokümante edilir.

**Doğrulama:** Contract fixture’ları yerel testlerle doğrulandı; authenticated provider E2E için ayrı opt-in staging workflow henüz eklenmedi.
**Bağımlılık:** DW-R05.
**Boyut:** L.

### DW-R07: İkinci provider seçimi ve adapter

**İş:** Gerçek kullanıcı talebine göre Railway veya Render’dan birini seç; iki provider’ı aynı anda başlatma.

**Kabul ölçütleri:**
- [ ] Seçim API kanıtı, deployment kimliği ve kullanıcı talebiyle ADR’de gerekçelendirilir.
- [ ] Provider status semantiği common state’e varsayım yapmadan eşlenir.
- [ ] Adapter ortak contract suite’i ve secret redaction testlerini geçirir.

**Doğrulama:** Fixture bazlı bütün state’ler ve dedicated staging E2E.
**Bağımlılık:** DW-R05, en az bir gerçek kullanıcı talebi.
**Boyut:** L.

**Checkpoint R2:** En az iki provider ortak karar/rapor sözleşmesini kullanır; provider-specific sınırlar consumer dokümanında görünür.

### DW-R08: Runtime ve provider image digest eşleştirme

**İş:** Beklenen OCI digest, provider deployment digest’i ve opsiyonel runtime build marker’ını ayrı kontrollerle ilişkilendir.

**İlerleme (2026-10-01):** Config v2 (`deployment.expectedImageDigest`) eklendi; config v1 strict/geriye uyumlu kaldı, `init` artık v2 üretip public v1/v2 JSON Schema’ları ayrı tutuluyor. V2 probe `imageDigestJsonPath` ile beklenen digest’i tek config alanından runtime JSON marker’ına uygular; aynı probe’da çakışan `expectedJson` reddedilir. CLI (`--expected-image-digest` / `DEPLOY_WITNESS_EXPECTED_IMAGE_DIGEST`) ve GitHub Action girdileri config değerini override eder. Ortak digest evaluator exact-match PASS, mismatch FAIL, missing/invalid UNKNOWN ve adapter destek yoksa required UNSUPPORTED üretiyor. Runtime JSON marker bağımsız çalışıyor; geçerli gözlenen digest rapora normalized biçimde ekleniyor, missing/invalid/mismatch ayrı failure code alıyor ve mismatch genel kararı FAIL yapıyor. Digest hex karşılaştırması yalnızca image marker için case-insensitive normalleştirilir. Resmi API alan incelemesinde mevcut Coolify/Vercel deployment kayıtları observed immutable digest göstermediği için bu adapter’lar fail-closed UNSUPPORTED kalıyor. Provider-side positive/mismatch fixture’ı, bir API gerçek deployment digest’i sunduğunda adapter entegrasyonuyla tamamlanacak.

**Kabul ölçütleri:**
- [x] Tag eşitliği immutable digest eşitliği sayılmaz; beklenen/gözlenen değerler `sha256:<64 hex>` doğrulamasından geçer.
- [x] Digest alanı sunmayan provider UNSUPPORTED bildirir; required policy PASS vermez.
- [x] Kaynak SHA, image digest ve runtime marker kontrolleri ayrı kalır; digest mismatch ve runtime marker uyuşmazlığı PASS vermez.

**Doğrulama:** Ortak evaluator için mismatch, missing, unsupported, invalid/tag, positive testleri; core seviyede runtime marker positive/mismatch; gerçek provider positive/mismatch fixtures unsupported provider API nedeniyle beklemede.
**Bağımlılık:** DW-R01, DW-R05.
**Boyut:** M.

### DW-R09: GitHub artifact attestation verifier (opt-in)

**İş:** GitHub artifact provenance signature/identity/subject doğrulamasını ayrı supply-chain check olarak ekle.

**İlerleme (2026-10-01):** Threat model ve mimari sınır [`ADR 0003`](../docs/adr/0003-github-artifact-attestation.md) içinde kabul edildi. Config v1/v2 ve report v1'in katı sözleşmeleri korunacak; uygulama öncesinde config v3/report v2 tasarımı gerekiyor. Kriptografik doğrulama GitHub CLI'ye delege edilecek, workflow-controlled predicate alanları güvenilir kimlik politikası sayılmayacak. Bu kayıt verifier'ın uygulandığı anlamına gelmez.

**Kabul ölçütleri:**
- [ ] Repository, workflow identity, commit, subject digest ve trust policy kontrol edilir.
- [ ] Attestation build provenance’ı kanıtlar; production runtime state olarak sunulmaz.
- [ ] Varsayılan optional davranış ve required policy kullanımı dokümante edilir.

**Doğrulama:** Trusted positive, wrong repo/workflow/digest, absent attestation ve invalid verification testleri.
**Bağımlılık:** DW-R08 ve ayrı threat-model ADR.
**Boyut:** L.

### DW-R10: npm OIDC release ve provenance

**Güncel yayın politikası (2026-10-04):** Kullanıcı isteğiyle yayıncı erol.senol olacak şekilde hesap kimliği zorunlu tutuldu. 0.3.0 yerel hesap oturumuyla yayımlandı; registry publisher/gitHead/integrity ve temiz consumer doğrulandı. Bu yerel yayında GitHub Actions provenance yoktur. CI hesap yayını için npm-publish ortamında NPM_TOKEN gerekir; aşağıdaki OIDC maddeleri 0.2.7 yayınının tarihsel kanıtıdır.

**İş:** İlk package bootstrap’i tamamlandıktan sonra tag bazlı npm Trusted Publishing workflow’u ve doğrulama rehberini ekle.

**İlerleme (2026-10-01):** Tag/environment kısıtlı `publish-npm.yml`, minimum `id-token: write` izniyle token’sız Trusted Publishing kullanıyor. `v0.2.7` registry’de görünür; SLSA provenance metadata’sı ve temiz consumer install doğrulandı.

**Kabul ölçütleri:**
- [x] Release workflow yalnızca protected tag/environment ile çalışır, minimum OIDC izinlerini alır.
- [x] Uzun ömürlü npm publish token kullanılmaz; provenance otomatik oluşur.
- [x] Paketin registry kurulumu ve provenance doğrulaması release gate’inden geçer.

**Doğrulama:** Test/staged package veya kontrollü public prerelease; registry version, tarball contents ve provenance kontrolü.
**Bağımlılık:** npm package hesabında Trusted Publisher bootstrap ayarı ve release approval.
**Boyut:** M.

### DW-R11: Consumer demos, governance ve v1 release gate

**İş:** Monorepo örneği, GitHub dışı CI örneği, support/security politikaları ve v1 API kararlılık kontrolünü hazırla.

**İlerleme (2026-10-01):** CI ve tag release gate’ine gerçek npm tarball’ını geçici consumer dizinine kuran smoke eklendi. Test kurulu paketten CLI sürümünü, config-v2 JSON Schema çıktısını, `VerificationConfigSchema` public import’unu ve Action manifestini doğruluyor. GitLab deploy/verify örneği YAML sözleşme testiyle, CLI ve Node Action ise yerel Coolify fixture’ında pozitif/negatif akışlarla doğrulanıyor.

**İlerleme (2026-10-01):** Destek matrisi ve 0.x semver/config-report schema geçiş kuralları `docs/support-policy.md` içinde yayımlandı; güvenlik ve genel hata bildirim kanalları, veri redaksiyonu ve yanıt süresi taahhüdü olmadığı da açıklandı.

**Kabul ölçütleri:**
- [x] CLI, Node Action ve GitHub dışı CI örneği clean consumer’da çalışır.
- [x] Security response, support matrix, semver ve schema migration policy yayınlanır.
- [ ] v1.0 yalnızca en az iki provider, P0 security, consumer ve release gate’leri geçtiğinde aday olur.

**Doğrulama:** CI matrix, consumer smoke, staging positive/negative controls ve release checklist.
**Bağımlılık:** DW-R04, DW-R06, DW-R07, DW-R10.
**Boyut:** L.

## 0.4.0 release dilimi

- [x] DW-R16: Bounded, strict ve decision-consistent report loader/public API.
- [x] DW-R17: Offline report CLI, JUnit, terminal/exit parity ve adversarial testler.
- [x] DW-R18: Docs, packed consumer, Node 22/24 CI, GitHub/npm release ve registry proof.

**DW-R18 checkpoint:** GitHub v0.4.0 yayımlandı, Node 22/24 CI başarılı, 216 test ve packed consumer geçti. npm 0.4.0 erol.senol hesabından yayımlandı; publisher/gitHead/integrity ve temiz registry CLI/schema/report/JUnit/API kontrolleri doğrulandı.

## 0.5.0 release dilimi

- [x] DW-R19: Escaped ortak Markdown formatter ve saldırgan girdi testleri.
- [x] DW-R20: CLI/Action Markdown integration ve packed consumer parity.
- [x] DW-R21: Çıktı çakışma/kaynak koruması, atomic artifact writer ve dosya testleri.
- [x] DW-R22: Docs, bundle, Node 22/24 CI, GitHub/npm ve registry consumer proof.

**DW-R22 kanıtı:** v0.5.0 GitHub/npm yayımlandı; 229 test, Node 22/24 CI, packed ve temiz registry consumer başarılı. Publisher erol.senol, gitHead `83bc0d00e729619de4b55f2b7d2b287484af6928`, tarball checksum/integrity eşleşti. CLI Markdown/JUnit ve public API doğrulandı.
