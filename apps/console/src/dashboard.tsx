import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Empty, Input, Layout, List, Modal, Space, Tag, Typography } from "antd";
import type { BuildArtifactSummary, CoolifyApplicationStatus, ProjectState, ReleaseEvidenceSnapshot, ReleaseRecordEvidence, RunAction, RunStatus } from "@deploy-relay/contracts";
import { deployRun, getArtifacts, getCoolify, getEvents, getProjects, getReleaseEvidence, getRuns, rollbackRun, startRun } from "./api.ts";

const { Header, Content } = Layout;
const { Title, Text, Paragraph } = Typography;

function statusColor(status: RunStatus): string {
  switch (status) {
    case "passed": return "green";
    case "failed": return "red";
    case "needs_attention": return "orange";
    case "running": return "blue";
    default: return "default";
  }
}

function statusLabel(status: RunStatus): string {
  switch (status) {
    case "queued": return "Sırada";
    case "running": return "Çalışıyor";
    case "passed": return "Başarılı";
    case "failed": return "Başarısız";
    case "needs_attention": return "İnceleme gerekli";
  }
}

function actionLabel(action: RunAction): string {
  switch (action) {
    case "plan": return "Plan";
    case "check": return "Kontroller";
    case "build": return "Paket oluşturma";
    case "deploy": return "Dağıtım";
    case "rollback": return "Geri alma";
    case "deploy-verify": return "Canlı dağıtım doğrulaması";
    case "db-status": return "Kurtarma durumu";
    case "db-drill": return "Kurtarma tatbikatı";
  }
}

function SectionHeading({ eyebrow, title, detail }: { readonly eyebrow: string; readonly title: string; readonly detail?: string | undefined }) {
  return <div className="section-heading"><div><Text className="eyebrow">{eyebrow}</Text><Title level={3}>{title}</Title></div>{detail && <Text type="secondary">{detail}</Text>}</div>;
}

function ReleaseEvidencePanel({ snapshot, project, busy, onRollback }: {
  readonly snapshot: ReleaseEvidenceSnapshot | undefined;
  readonly project: ProjectState | undefined;
  readonly busy: boolean;
  readonly onRollback: (project: ProjectState, sha: string) => void;
}) {
  if (!project?.rollbackAvailable) return null;
  if (!snapshot || snapshot.availability === "unavailable") {
    return <Alert type="warning" showIcon className="notice" message={snapshot?.error ?? "Release kanıtı okunuyor."} />;
  }
  const recordText = (record: ReleaseRecordEvidence) => <div className="release-record">
    <Text className="sha">{record.sha}</Text>
    <Text type="secondary">Yayın başlangıcı · {new Date(record.startedAt).toLocaleString("tr-TR")}</Text>
  </div>;
  return <Card className="evidence-card">
    <SectionHeading eyebrow="ÜRETİM GÖZLEMİ" title="Release kanıtı" detail={`Son kontrol · ${new Date(snapshot.checkedAt).toLocaleTimeString("tr-TR")}`} />
    {snapshot.current ? <>
      <div className="evidence-current">{recordText(snapshot.current)}<Tag color={snapshot.runtimeMatchesCurrent ? "green" : "red"}>{snapshot.runtimeMatchesCurrent ? "Çalışan imajlarla eşleşiyor" : "Çalışan imajlarla eşleşmiyor"}</Tag></div>
      <div className="evidence-images">
        <Text className="eyebrow">ÇALIŞAN İMAJLAR</Text>
        <List size="small" dataSource={[...snapshot.runtimeImages]} locale={{ emptyText: "Çalışan imaj kanıtı yok" }} renderItem={(image) => <List.Item>
          <div className="image-evidence"><div className="image-evidence-top"><Text strong>{image.logicalName}</Text><Text type="secondary">{image.status} · {image.health}</Text></div><Text className="sha image-reference">{image.reference}</Text><Text type="secondary" className="sha image-reference">{image.imageId}</Text></div>
        </List.Item>} />
      </div>
    </> : <Alert type="warning" showIcon message="Doğrulanmış güncel release ledger kaydı bulunamadı." />}
    <div className="rollback-section"><div className="rollback-heading"><Title level={5}>Geri alma adayları</Title><Text type="secondary">Yalnızca geçmişte sağlıklı olduğu doğrulanan sürümler</Text></div>
      <List size="small" dataSource={[...snapshot.rollbackCandidates]} locale={{ emptyText: "Önceki sağlıklı release kaydı yok." }} renderItem={(candidate) => <List.Item actions={[<Button key="rollback" danger disabled={busy || snapshot.runtimeMatchesCurrent !== true || project.clean !== true || project.branch !== project.productionBranch} onClick={() => onRollback(project, candidate.sha)}>Bu SHA’ya dön</Button>] }>
        {recordText(candidate)}
      </List.Item>} />
    </div>
  </Card>;
}

function ProjectCard({ project, applications, artifact, onStart, onDeploy, busy }: {
  readonly project: ProjectState;
  readonly applications: readonly CoolifyApplicationStatus[];
  readonly artifact: BuildArtifactSummary | undefined;
  readonly onStart: (projectId: string, action: Exclude<RunAction, "deploy" | "rollback">) => void;
  readonly onDeploy: (project: ProjectState, artifact: BuildArtifactSummary) => void;
  readonly busy: boolean;
}) {
  const projectStatus = project.error ? "Erişilemiyor" : project.clean === true ? "Temiz" : project.clean === false ? "Değişiklik var" : "Durum bekleniyor";
  const projectStatusColor = project.error ? "red" : project.clean === true ? "green" : project.clean === false ? "orange" : "default";
  return <Card className="project-card" title={<div className="project-title"><span className={`project-dot ${project.error ? "is-error" : project.clean === true ? "is-ready" : "is-pending"}`} /><span>{project.name}</span></div>} extra={<Tag color={projectStatusColor}>{projectStatus}</Tag>}>
    <div className="project-info">
      <div className="source-info"><div><Text className="meta-label">KAYNAK DALI</Text><Text strong>{project.branch ?? "—"}</Text></div><div><Text className="meta-label">ÜRETİM DALI</Text><Text>{project.productionBranch}</Text></div></div>
      <div className="sha-row"><Text type="secondary">Kaynak SHA</Text><Text className="sha">{project.sha?.slice(0, 12) ?? "—"}</Text></div>
      {artifact && <div className="artifact-info"><Text className="meta-label">DOĞRULANMIŞ PAKET</Text><Text className="sha">{artifact.sha.slice(0, 12)} <span className="artifact-separator">·</span> manifest {artifact.manifestHash.slice(0, 12)}</Text></div>}
      {applications.map((application) => <div className="application-info" key={application.uuid}><div className="application-heading"><Text strong>{application.name}</Text><Tag color={application.status === "running:healthy" ? "green" : "orange"}>{application.status}</Tag></div><Text type="secondary">{application.branch ?? "Dal bilinmiyor"} · {application.buildPack ?? "Paket bilinmiyor"}</Text></div>)}
      {project.error && <Alert type="error" showIcon message={project.error} />}
    </div>
    <div className="actions">
      <Button onClick={() => onStart(project.id, "plan")} disabled={busy || Boolean(project.error)}>Planı gör</Button>
      <Button type="primary" onClick={() => onStart(project.id, "check")} disabled={busy || project.clean !== true}>Kontrolleri başlat</Button>
      {project.buildAvailable && <Button onClick={() => onStart(project.id, "build")} disabled={busy || project.clean !== true || project.branch !== project.productionBranch}>Paket oluştur</Button>}
      {project.deployAvailable && artifact && <Button danger onClick={() => onDeploy(project, artifact)} disabled={busy || project.clean !== true || project.branch !== project.productionBranch || project.sha !== artifact.sha}>Üretime gönder</Button>}
    </div>
  </Card>;
}

export function Dashboard() {
  const queryClient = useQueryClient();
  const [chosenRunId, setChosenRunId] = useState<string | null>(null);
  const [deployCandidate, setDeployCandidate] = useState<{ readonly project: ProjectState; readonly artifact: BuildArtifactSummary } | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [rollbackCandidate, setRollbackCandidate] = useState<ProjectState | null>(null);
  const [rollbackSha, setRollbackSha] = useState("");
  const [rollbackConfirmation, setRollbackConfirmation] = useState("");
  const projects = useQuery({ queryKey: ["projects"], queryFn: getProjects, refetchInterval: 5000 });
  const artifacts = useQuery({ queryKey: ["artifacts"], queryFn: getArtifacts, refetchInterval: 5000 });
  const coolify = useQuery({ queryKey: ["coolify"], queryFn: getCoolify, refetchInterval: 15_000 });
  const releaseEvidence = useQuery({ queryKey: ["release-evidence"], queryFn: getReleaseEvidence, refetchInterval: 30_000 });
  const runs = useQuery({ queryKey: ["runs"], queryFn: getRuns, refetchInterval: 1500 });
  const activeRun = runs.data?.find((run) => run.id === chosenRunId) ?? runs.data?.[0];
  const events = useQuery({
    queryKey: ["events", activeRun?.id],
    queryFn: () => getEvents(activeRun!.id),
    enabled: Boolean(activeRun),
    refetchInterval: activeRun?.status === "running" || activeRun?.status === "queued" ? 1000 : false,
  });
  const start = useMutation({
    mutationFn: ({ projectId, action }: { projectId: string; action: Exclude<RunAction, "deploy" | "rollback"> }) => startRun(projectId, action),
    onSuccess: (run) => {
      setChosenRunId(run.id);
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
    },
  });
  const deploy = useMutation({
    mutationFn: ({ projectId, artifact }: { projectId: string; artifact: BuildArtifactSummary }) => deployRun(projectId, artifact),
    onSuccess: (run) => {
      setChosenRunId(run.id);
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      void queryClient.invalidateQueries({ queryKey: ["release-evidence"] });
    },
  });
  const rollback = useMutation({
    mutationFn: ({ projectId, sha }: { projectId: string; sha: string }) => rollbackRun(projectId, sha),
    onSuccess: (run) => {
      setChosenRunId(run.id);
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["release-evidence"] });
    },
  });
  const busy = start.isPending || deploy.isPending || rollback.isPending;
  const agentUnavailable = Boolean(projects.error || runs.error);

  return <Layout className="shell">
    <Header className="topbar"><div className="topbar-inner"><div className="brand-lockup"><svg className="brand-symbol" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="header-mark-gradient" x1="8" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse"><stop stopColor="#4F86EE" /><stop offset="1" stopColor="#2855A7" /></linearGradient></defs><rect width="64" height="64" rx="17" fill="#102443" /><rect x="4" y="4" width="56" height="56" rx="15" fill="url(#header-mark-gradient)" /><path d="M10 32h13m28 0h5m0 0-4-4m4 4-4 4" fill="none" stroke="#DCE8FF" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.5" /><circle cx="12" cy="32" r="2.3" fill="#60D89B" /><rect x="23" y="20" width="28" height="24" rx="8" fill="#173A70" stroke="#F7FAFF" strokeWidth="2.5" /><path d="m30 32 5 5 9-10" fill="none" stroke="#70E0AC" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.5" /></svg><div className="brand-copy"><span className="brand-name">WitnessOps</span><span className="brand-caption">RELEASE VE KURTARMA KANITI</span></div></div><div className="topbar-meta"><div className={`agent-indicator ${agentUnavailable ? "is-offline" : ""}`} role="status" aria-live="polite"><span className={`connection-dot ${agentUnavailable ? "offline" : ""}`} aria-hidden="true" /><span className="agent-label">{agentUnavailable ? "Agent bağlantısı yok" : "Yerel agent bağlı"}</span></div><span className="environment-pill"><span>MAC</span><span className="environment-divider">·</span><span className="environment-local">YEREL</span></span></div></div></Header>
    <Content className="content">
      <div className="intro"><div><Text className="eyebrow">OPERASYON MERKEZİ</Text><Title level={2}>Sürüm kontrolü</Title><Paragraph type="secondary">Projelerin kaynak durumunu doğrula, kontrolleri çalıştır ve release adımlarını izle.</Paragraph></div><div className="intro-status"><span className={`connection-dot ${agentUnavailable ? "offline" : ""}`} /><span>{agentUnavailable ? "Bağlantı bekleniyor" : "Durumlar otomatik yenileniyor"}</span></div></div>
      {agentUnavailable && <Alert type="error" showIcon className="notice" message="Agent'a bağlanılamıyor" description="Yerel servisin çalıştığını kontrol edin. Proje ve iş durumları yenilenemiyor." />}
      <Alert type="info" showIcon className="notice guidance-notice" message="Dağıtım ve geri alma korumaları etkin" description="Dağıtım doğrulanmış pakete, geri alma önceki sağlıklı sürüm SHA'sına bağlıdır. Her iki işlem açık onay ister; sonucu belirsiz işlemler otomatik tekrarlanmaz." />
      {coolify.data?.availability === "not_configured" && <Alert type="warning" showIcon className="notice" message="Coolify bağlantısı yapılandırılmamış" description="Durum bilgisini göstermek için yerel agent ortamında COOLIFY_API_TOKEN ve COOLIFY_API_BASE_URL gerekli." />}
      {(coolify.error || coolify.data?.availability === "unavailable") && <Alert type="warning" showIcon className="notice" message="Coolify durumuna erişilemiyor" description={coolify.data?.error ?? "Bir sonraki yenilemede tekrar denenecek."} />}
      {coolify.data?.availability === "ready" && <div className="coolify-check"><span className="connection-dot" /><Text>Coolify okundu · {new Date(coolify.data.checkedAt).toLocaleTimeString("tr-TR")}</Text><Text type="secondary">Bu durum yeni sürümün dağıtıldığını kanıtlamaz.</Text></div>}
      {(start.error || deploy.error || rollback.error) && <Alert type="error" showIcon className="notice" message={(start.error ?? deploy.error ?? rollback.error)?.message} />}
      <ReleaseEvidencePanel snapshot={releaseEvidence.data} project={projects.data?.find((project) => project.rollbackAvailable)} busy={busy} onRollback={(selectedProject, sha) => { setRollbackCandidate(selectedProject); setRollbackSha(sha); setRollbackConfirmation(""); }} />
      {projects.data?.length === 0 && <Alert type="info" showIcon className="notice" message="İlk projeyi ekleyin" description="Yerel WitnessOps proje kataloğunu hazırlayın; örnek yapılandırma ve üç modülün alanları README içinde açıklanıyor." />}
      <section className="projects-section"><SectionHeading eyebrow="KAYNAK VE DAĞITIM" title="Projeler" detail={projects.data ? `${projects.data.length} proje` : "Proje durumları yükleniyor"} />
        {projects.isLoading ? <div className="loading-card"><Empty description="Proje durumları alınıyor…" image={Empty.PRESENTED_IMAGE_SIMPLE} /></div> : projects.data?.length ? <div className="project-grid">{projects.data.map((project) => <ProjectCard key={project.id} project={project} applications={coolify.data?.applications.filter((application) => project.coolifyApplications.includes(application.uuid)) ?? []} artifact={artifacts.data?.find((artifact) => artifact.projectId === project.id)} busy={busy} onStart={(projectId, action) => start.mutate({ projectId, action })} onDeploy={(selectedProject, artifact) => { setDeployCandidate({ project: selectedProject, artifact }); setConfirmation(""); }} />)}</div> : !projects.error && <div className="loading-card"><Empty description="Yapılandırılmış proje bulunamadı" image={Empty.PRESENTED_IMAGE_SIMPLE} /></div>}
      </section>
      <section className="projects-section"><SectionHeading eyebrow="CANLI KANIT" title="Deploy doğrulama" detail="Beklenen commit ve sağlık uçları" />
        <div className="project-grid">{projects.data?.filter((project) => project.deployVerificationAvailable).map((project) => <Card key={project.id} title={project.name}>
          <Paragraph type="secondary">Kaynak SHA ile sağlayıcı kaydını ve dışarıdan erişilen uygulamayı doğrula.</Paragraph>
          <Button type="primary" disabled={busy || project.clean !== true} onClick={() => start.mutate({ projectId: project.id, action: "deploy-verify" })}>Canlı sürümü doğrula</Button>
        </Card>)}
        {!projects.data?.some((project) => project.deployVerificationAvailable) && <Empty description="Deploy doğrulama yapılandırılmamış" image={Empty.PRESENTED_IMAGE_SIMPLE} />}</div>
      </section>
      <section className="projects-section"><SectionHeading eyebrow="VERİTABANI KURTARMA" title="Yedek ve restore kanıtı" detail="İzole kurtarma tatbikatları" />
        <div className="project-grid">{projects.data?.filter((project) => project.databaseRecoveryAvailable).map((project) => <Card key={project.id} title={project.name}>
          <Paragraph type="secondary">Yedek durumunu incele veya izole PostgreSQL ortamında kurtarma tatbikatı çalıştır.</Paragraph>
          <Space wrap>
            <Button disabled={busy} onClick={() => start.mutate({ projectId: project.id, action: "db-status" })}>Yedek durumu</Button>
            <Button type="primary" disabled={busy} onClick={() => start.mutate({ projectId: project.id, action: "db-drill" })}>Kurtarmayı doğrula</Button>
          </Space>
        </Card>)}
        {!projects.data?.some((project) => project.databaseRecoveryAvailable) && <Empty description="Veritabanı kurtarma yapılandırılmamış" image={Empty.PRESENTED_IMAGE_SIMPLE} />}</div>
      </section>
      <div className="lower-grid">
        <section><SectionHeading eyebrow="İŞ KUYRUĞU" title="Son işler" detail={runs.data?.length ? `${runs.data.length} kayıt` : undefined} /><Card className="runs-card"><List dataSource={runs.data ?? []} locale={{ emptyText: <Empty description="Henüz iş yok" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} renderItem={(run) => <List.Item className="run-list-item"><button type="button" className={`run-select ${run.id === activeRun?.id ? "selected-run" : ""}`} aria-pressed={run.id === activeRun?.id} onClick={() => setChosenRunId(run.id)}><span className="run-select-heading"><Text strong>{run.projectId}</Text><Tag color={statusColor(run.status)}>{statusLabel(run.status)}</Tag></span><span className="run-select-meta">{actionLabel(run.action)} <span>·</span> {new Date(run.createdAt).toLocaleString("tr-TR")}</span></button></List.Item>} /></Card></section>
        <section><SectionHeading eyebrow="CANLI İZLEME" title="İş ayrıntısı" detail={activeRun ? `Güncellendi · ${new Date(activeRun.updatedAt).toLocaleTimeString("tr-TR")}` : undefined} /><Card className="detail-card">{activeRun ? <><div className="detail-header"><div><Text className="meta-label">{activeRun.projectId} · {actionLabel(activeRun.action)}</Text><div className="detail-status"><Tag color={statusColor(activeRun.status)}>{statusLabel(activeRun.status)}</Tag><Text className="sha">{activeRun.sourceSha?.slice(0, 12) ?? "SHA bekleniyor"}</Text></div></div></div>
          {activeRun.error && <Alert type="error" showIcon className="notice" message={activeRun.error} />}
          {events.data?.some((event) => event.message === "Evidence report is available.") && <Paragraph><a href={`/api/runs/${activeRun.id}/report`} target="_blank" rel="noreferrer">Kanıt raporunu aç</a></Paragraph>}
          {events.data?.some((event) => event.message === "db evidence report is available.") && <Paragraph><a href={`/api/runs/${activeRun.id}/report?kind=db`} target="_blank" rel="noreferrer">Kurtarma raporunu aç</a></Paragraph>}
          {events.data?.some((event) => event.message === "deploy evidence report is available.") && <Paragraph><a href={`/api/runs/${activeRun.id}/report?kind=deploy`} target="_blank" rel="noreferrer">Deploy doğrulama raporunu aç</a></Paragraph>}
          <div className="event-list">{events.data?.map((event) => <div key={event.sequence} className={`event event-${event.kind}`}><time>{new Date(event.at).toLocaleTimeString("tr-TR")}</time><span>{event.message}</span></div>)}{!events.data?.length && <Empty description={events.isLoading ? "Adımlar yükleniyor…" : "Adım kaydı bekleniyor"} image={Empty.PRESENTED_IMAGE_SIMPLE} />}</div>
        </> : <Empty description="Ayrıntılarını görmek için bir iş seçin" image={Empty.PRESENTED_IMAGE_SIMPLE} />}</Card></section>
      </div>
      <Modal title="Üretime gönder" open={deployCandidate !== null} okText="Dağıtımı başlat" okButtonProps={{ danger: true, disabled: confirmation !== deployCandidate?.artifact.sha.slice(0, 12), loading: deploy.isPending }} onCancel={() => setDeployCandidate(null)} onOk={() => { if (deployCandidate) deploy.mutate({ projectId: deployCandidate.project.id, artifact: deployCandidate.artifact }); setDeployCandidate(null); }}>
        <Paragraph>{deployCandidate?.project.name} için <Text strong className="sha">{deployCandidate?.artifact.sha.slice(0, 12)}</Text> kaynağını üretime göndereceksiniz. Onay için SHA'nın ilk 12 karakterini yazın.</Paragraph>
        <Input aria-label="Dağıtım SHA onayı" value={confirmation} onChange={(event) => setConfirmation(event.target.value.trim())} placeholder={deployCandidate?.artifact.sha.slice(0, 12)} />
      </Modal>
      <Modal title="Önceki sağlıklı sürüme dön" open={rollbackCandidate !== null} okText="Geri almayı başlat" okButtonProps={{ danger: true, loading: rollback.isPending, disabled: !/^[a-f0-9]{40}$/.test(rollbackSha) || rollbackConfirmation !== rollbackSha.slice(0, 12) }} onCancel={() => setRollbackCandidate(null)} onOk={() => { if (rollbackCandidate && /^[a-f0-9]{40}$/.test(rollbackSha)) rollback.mutate({ projectId: rollbackCandidate.id, sha: rollbackSha }); setRollbackCandidate(null); }}>
        <Paragraph>{rollbackCandidate?.name} için önceki sağlıklı sürümün 40 karakter SHA değerini girin. Yerel receiver hedefin geçmişte doğrulanmış sağlıklı sürüm olduğunu kontrol eder; işlem sonrası girilen SHA için canlı smoke çalışır.</Paragraph>
        <Input aria-label="Geri alınacak SHA" value={rollbackSha} readOnly placeholder="Ledger adaylarından seçin" maxLength={40} />
        <Paragraph className="confirm-hint">Onaylamak için SHA'nın ilk 12 karakterini tekrar yazın.</Paragraph>
        <Input aria-label="Geri alma SHA onayı" value={rollbackConfirmation} onChange={(event) => setRollbackConfirmation(event.target.value.trim().toLowerCase())} placeholder={rollbackSha.slice(0, 12) || "SHA ön eki"} maxLength={12} />
      </Modal>
    </Content>
  </Layout>;
}
