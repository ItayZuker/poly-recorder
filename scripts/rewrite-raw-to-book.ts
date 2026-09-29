import "dotenv/config";
import { closeMongoClient } from "../src/db/mongo-client.js";
import { rewriteRawWindowsToBook } from "../src/db/rewrite-raw-to-book.js";

const stats = await rewriteRawWindowsToBook();
const totals = stats.reduce(
  (sum, row) => {
    sum.windowsConverted += row.windowsConverted;
    sum.windowsSkipped += row.windowsSkipped;
    sum.rawFilesDeleted += row.rawFilesDeleted;
    sum.bookBytesWritten += row.bookBytesWritten;
    return sum;
  },
  { windowsConverted: 0, windowsSkipped: 0, rawFilesDeleted: 0, bookBytesWritten: 0 },
);
console.log(
  `[book] total: windows converted ${totals.windowsConverted}, windows skipped ${totals.windowsSkipped}, raw files deleted ${totals.rawFilesDeleted}, book bytes written ${totals.bookBytesWritten}`,
);
await closeMongoClient();
