import { PrismaClient } from "@prisma/client";

// One PrismaClient per process; injected into services (kept as a module singleton
// here for simplicity, but tests can import and reset it against a temp DB).
export const prisma = new PrismaClient();
