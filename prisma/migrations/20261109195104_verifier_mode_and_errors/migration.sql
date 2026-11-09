-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN "verifyError" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Verification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "milestoneId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "scorePct" REAL NOT NULL,
    "summary" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'browser',
    "rawJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Verification_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "Milestone" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Verification_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Verification" ("createdAt", "deliveryId", "id", "milestoneId", "model", "rawJson", "scorePct", "summary") SELECT "createdAt", "deliveryId", "id", "milestoneId", "model", "rawJson", "scorePct", "summary" FROM "Verification";
DROP TABLE "Verification";
ALTER TABLE "new_Verification" RENAME TO "Verification";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
