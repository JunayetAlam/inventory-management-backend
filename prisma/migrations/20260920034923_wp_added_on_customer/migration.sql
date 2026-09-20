-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "whatsappNumber" TEXT;

-- CreateIndex
CREATE INDEX "customers_whatsappNumber_idx" ON "customers"("whatsappNumber");
