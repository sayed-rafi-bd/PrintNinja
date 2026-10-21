import type {
  TemplateSummaryView,
  TemplateView,
  VersionSummaryView,
  VersionView,
} from "../../domain/templatePorts.js";

// Row shapes shared by the Prisma repositories (templates, saved,
// sync): one mapping from storage to domain, not one per query site.

export type PrismaTemplate = {
  id: string;
  ownerId: string;
  name: string;
  summary: string;
  pageWMm: number;
  pageHMm: number;
  language: string;
  body: string;
  css: string;
  readme: string;
  useCount: number;
  revision: number;
  changeSeq: bigint;
  publishedAt: Date | null;
  firstPublishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  owner: { handle: string };
  _count: { versions: number };
};

export function toTemplateView(template: PrismaTemplate): TemplateView {
  return {
    ...recordTemplateFields(template),
    ownerHandle: template.owner.handle,
    versionCount: template._count.versions,
  };
}

export function toTemplateSummaryView(
  template: PrismaTemplate,
): TemplateSummaryView {
  return {
    id: template.id,
    ownerId: template.ownerId,
    ownerHandle: template.owner.handle,
    name: template.name,
    summary: template.summary,
    pageWMm: template.pageWMm,
    pageHMm: template.pageHMm,
    language: template.language,
    useCount: template.useCount,
    revision: template.revision,
    versionCount: template._count.versions,
    publishedAt: template.publishedAt,
    updatedAt: template.updatedAt,
  };
}

export type PrismaVersion = {
  templateId: string;
  versionNo: number;
  body: string;
  css: string;
  createdBy: "manual" | "autosave" | "restore";
  label: string | null;
  note: string | null;
  createdAt: Date;
};

export function toVersionView(row: PrismaVersion): VersionView {
  return {
    templateId: row.templateId,
    versionNo: row.versionNo,
    body: row.body,
    css: row.css,
    createdBy: row.createdBy,
    label: row.label,
    note: row.note,
    createdAt: row.createdAt,
  };
}

export function toVersionSummaryView(row: PrismaVersion): VersionSummaryView {
  return {
    versionNo: row.versionNo,
    createdBy: row.createdBy,
    label: row.label,
    note: row.note,
    createdAt: row.createdAt,
  };
}

function recordTemplateFields(template: PrismaTemplate) {
  return {
    id: template.id,
    ownerId: template.ownerId,
    name: template.name,
    summary: template.summary,
    pageWMm: template.pageWMm,
    pageHMm: template.pageHMm,
    language: template.language,
    body: template.body,
    css: template.css,
    readme: template.readme,
    useCount: template.useCount,
    revision: template.revision,
    changeSeq: template.changeSeq,
    publishedAt: template.publishedAt,
    firstPublishedAt: template.firstPublishedAt,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}
