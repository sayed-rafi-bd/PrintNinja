-- DropForeignKey
ALTER TABLE "saved_templates" DROP CONSTRAINT "saved_templates_template_id_fkey";

-- CreateIndex
CREATE INDEX "saved_templates_template_id_idx" ON "saved_templates"("template_id");
