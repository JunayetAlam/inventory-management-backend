/*
  Warnings:

  - You are about to drop the column `tagline` on the `shops` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "shops" DROP COLUMN "tagline",
ADD COLUMN     "proprietor" TEXT;
