-- CreateTable
CREATE TABLE "template_use_daily" (
    "user_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "template_use_daily_pkey" PRIMARY KEY ("user_id","template_id","day")
);

-- AddForeignKey
ALTER TABLE "template_use_daily" ADD CONSTRAINT "template_use_daily_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
