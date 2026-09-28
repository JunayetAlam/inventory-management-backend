/*
  Warnings:

  - You are about to drop the column `discount` on the `receipt_items` table. All the data in the column will be lost.
  - You are about to drop the column `discount` on the `return_invoice_items` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "receipt_items" DROP COLUMN "discount",
ADD COLUMN     "discounts" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[];

-- AlterTable
ALTER TABLE "return_invoice_items" DROP COLUMN "discount",
ADD COLUMN     "discounts" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[];
