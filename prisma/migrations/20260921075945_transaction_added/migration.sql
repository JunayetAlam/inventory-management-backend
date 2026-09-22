-- CreateEnum
CREATE TYPE "CustomerTransactionType" AS ENUM ('RECEIPT', 'PAYMENT', 'RETURN_INVOICE');

-- CreateTable
CREATE TABLE "customer_transactions" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" "CustomerTransactionType" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "receiptId" TEXT,
    "paymentId" TEXT,
    "returnInvoiceId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_transactions_customerId_idx" ON "customer_transactions"("customerId");

-- CreateIndex
CREATE INDEX "customer_transactions_type_idx" ON "customer_transactions"("type");

-- CreateIndex
CREATE INDEX "customer_transactions_receiptId_idx" ON "customer_transactions"("receiptId");

-- CreateIndex
CREATE INDEX "customer_transactions_paymentId_idx" ON "customer_transactions"("paymentId");

-- CreateIndex
CREATE INDEX "customer_transactions_returnInvoiceId_idx" ON "customer_transactions"("returnInvoiceId");

-- CreateIndex
CREATE INDEX "customer_transactions_createdById_idx" ON "customer_transactions"("createdById");

-- CreateIndex
CREATE INDEX "customer_transactions_createdAt_idx" ON "customer_transactions"("createdAt");

-- AddForeignKey
ALTER TABLE "customer_transactions" ADD CONSTRAINT "customer_transactions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_transactions" ADD CONSTRAINT "customer_transactions_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_transactions" ADD CONSTRAINT "customer_transactions_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "receipt_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_transactions" ADD CONSTRAINT "customer_transactions_returnInvoiceId_fkey" FOREIGN KEY ("returnInvoiceId") REFERENCES "return_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_transactions" ADD CONSTRAINT "customer_transactions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
