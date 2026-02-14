// ============================================================
// DAO ROUTES — Add to server.ts or create routes/dao.ts
// ============================================================
// Usage: app.route("/api/dao", daoRouter);
// ============================================================

import { Hono } from "hono";
import { prisma } from "../db/index.js";
import { createPublicClient, http, erc20Abi, formatUnits } from "viem";
import { monadTestnet } from "viem/chains";

const daoRouter = new Hono();

const COUNCIL_TOKEN_ADDRESS = (process.env.COUNCIL_TOKEN_ADDRESS ||
  "0xbE68317D0003187342eCBE7EECA364E4D09e7777") as `0x${string}`;

const ADMIN_WALLETS = (process.env.DAO_ADMIN_WALLETS || "")
  .toLowerCase()
  .split(",")
  .filter(Boolean);

// Viem client for balance checks
const client = createPublicClient({
  chain: monadTestnet,
  transport: http(process.env.MONAD_RPC_URL || "https://rpc.monad.xyz"),
});

// ============================================================
// HELPERS
// ============================================================

async function getCouncilBalance(walletAddress: string): Promise<number> {
  try {
    const balance = await client.readContract({
      address: COUNCIL_TOKEN_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [walletAddress as `0x${string}`],
    });
    return parseFloat(formatUnits(balance, 18));
  } catch (e) {
    console.error("Error fetching COUNCIL balance:", e);
    return 0;
  }
}

function isAdmin(wallet: string): boolean {
  return ADMIN_WALLETS.includes(wallet.toLowerCase());
}

// ============================================================
// GET /api/dao/proposals — List all proposals
// ============================================================

daoRouter.get("/proposals", async (c) => {
  try {
    const status = c.req.query("status"); // 'active' | 'closed' | 'all'
    const where: any = {};

    if (status && status !== "all") {
      where.status = status;
    }

    const proposals = await prisma.daoProposal.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        votes: {
          select: {
            optionIndex: true,
            weight: true,
            walletAddress: true,
          },
        },
      },
    });

    const enriched = proposals.map((p: any) => {
      const options = p.options as string[];
      const now = new Date();
      const isActive = p.status === "active" && now < new Date(p.endsAt);
      const isExpired = p.status === "active" && now >= new Date(p.endsAt);

      // Tally votes per option
      const optionTallies = options.map((label: string, i: number) => {
        const optionVotes = p.votes.filter((v: any) => v.optionIndex === i);
        const totalWeight = optionVotes.reduce(
          (sum: number, v: any) => sum + v.weight,
          0,
        );
        return {
          index: i,
          label,
          votes: optionVotes.length,
          weight: Math.round(totalWeight * 100) / 100,
        };
      });

      const totalWeight = optionTallies.reduce(
        (sum: number, o: any) => sum + o.weight,
        0,
      );

      // Add percentage to each option
      const optionsWithPercent = optionTallies.map((o: any) => ({
        ...o,
        percent:
          totalWeight > 0
            ? Math.round((o.weight / totalWeight) * 1000) / 10
            : 0,
      }));

      // Determine winner
      const winner = [...optionsWithPercent].sort(
        (a, b) => b.weight - a.weight,
      )[0];

      return {
        id: p.id,
        title: p.title,
        description: p.description,
        type: p.type,
        options: optionsWithPercent,
        status: isExpired ? "closed" : isActive ? "active" : p.status,
        startsAt: p.startsAt,
        endsAt: p.endsAt,
        totalVotes: p.votes.length,
        totalWeight: Math.round(totalWeight * 100) / 100,
        winningOption: isExpired || p.status === "closed" ? winner : null,
        createdBy: p.createdBy,
        createdAt: p.createdAt,
      };
    });

    return c.json({
      proposals: enriched,
      count: enriched.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching proposals:", error);
    return c.json({ error: "Failed to fetch proposals" }, 500);
  }
});

// ============================================================
// GET /api/dao/proposals/:id — Single proposal with details
// ============================================================

daoRouter.get("/proposals/:id", async (c) => {
  try {
    const id = c.req.param("id");

    const proposal = await prisma.daoProposal.findUnique({
      where: { id },
      include: {
        votes: {
          select: {
            walletAddress: true,
            optionIndex: true,
            weight: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!proposal) return c.json({ error: "Proposal not found" }, 404);

    const options = proposal.options as string[];
    const now = new Date();
    const isActive =
      proposal.status === "active" && now < new Date(proposal.endsAt);

    const optionTallies = options.map((label: string, i: number) => {
      const optionVotes = proposal.votes.filter((v) => v.optionIndex === i);
      const totalWeight = optionVotes.reduce((sum, v) => sum + v.weight, 0);
      return {
        index: i,
        label,
        votes: optionVotes.length,
        weight: Math.round(totalWeight * 100) / 100,
        voters: optionVotes.map((v) => ({
          wallet: `${v.walletAddress.slice(0, 6)}...${v.walletAddress.slice(-4)}`,
          weight: Math.round(v.weight * 100) / 100,
          votedAt: v.createdAt,
        })),
      };
    });

    const totalWeight = optionTallies.reduce((sum, o) => sum + o.weight, 0);

    return c.json({
      proposal: {
        id: proposal.id,
        title: proposal.title,
        description: proposal.description,
        type: proposal.type,
        status: isActive ? "active" : "closed",
        startsAt: proposal.startsAt,
        endsAt: proposal.endsAt,
        totalVotes: proposal.votes.length,
        totalWeight: Math.round(totalWeight * 100) / 100,
        options: optionTallies.map((o) => ({
          ...o,
          percent:
            totalWeight > 0
              ? Math.round((o.weight / totalWeight) * 1000) / 10
              : 0,
        })),
        createdBy: proposal.createdBy,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching proposal:", error);
    return c.json({ error: "Failed to fetch proposal" }, 500);
  }
});

// ============================================================
// POST /api/dao/proposals — Create proposal (admin only)
// ============================================================

daoRouter.post("/proposals", async (c) => {
  try {
    const body = await c.req.json();
    const { title, description, type, options, durationHours, walletAddress } =
      body;

    // Validation
    if (!title || title.length < 3)
      return c.json({ error: "Title required (min 3 chars)" }, 400);
    if (!description) return c.json({ error: "Description required" }, 400);
    if (!options || !Array.isArray(options) || options.length < 2)
      return c.json({ error: "At least 2 options required" }, 400);
    if (options.length > 10) return c.json({ error: "Max 10 options" }, 400);
    if (!walletAddress)
      return c.json({ error: "Wallet address required" }, 400);

    // Check admin or min COUNCIL balance to create proposals
    const isAdminWallet = isAdmin(walletAddress);
    if (!isAdminWallet) {
      const balance = await getCouncilBalance(walletAddress);
      const minToCreate = parseFloat(
        process.env.DAO_MIN_CREATE_BALANCE || "10000",
      );
      if (balance < minToCreate) {
        return c.json(
          {
            error: `Need ${minToCreate.toLocaleString()} $COUNCIL to create proposals`,
            yourBalance: balance,
          },
          403,
        );
      }
    }

    const duration = Math.min(Math.max(durationHours || 24, 1), 168); // 1h to 7 days
    const endsAt = new Date(Date.now() + duration * 60 * 60 * 1000);

    const proposal = await prisma.daoProposal.create({
      data: {
        title,
        description,
        type: type || "custom",
        options: options as any,
        endsAt,
        createdBy: walletAddress,
      },
    });

    console.log(
      `🗳️ New DAO proposal: "${title}" by ${walletAddress.slice(0, 8)}...`,
    );

    return c.json({
      success: true,
      proposal: {
        id: proposal.id,
        title: proposal.title,
        endsAt: proposal.endsAt,
        options,
      },
    });
  } catch (error) {
    console.error("Error creating proposal:", error);
    return c.json({ error: "Failed to create proposal" }, 500);
  }
});

// ============================================================
// POST /api/dao/vote — Vote on a proposal
// ============================================================

daoRouter.post("/vote", async (c) => {
  try {
    const body = await c.req.json();
    const { proposalId, optionIndex, walletAddress } = body;

    // Validation
    if (!proposalId) return c.json({ error: "proposalId required" }, 400);
    if (optionIndex === undefined || optionIndex === null)
      return c.json({ error: "optionIndex required" }, 400);
    if (!walletAddress) return c.json({ error: "walletAddress required" }, 400);

    // Check proposal exists and is active
    const proposal = await prisma.daoProposal.findUnique({
      where: { id: proposalId },
    });

    if (!proposal) return c.json({ error: "Proposal not found" }, 404);
    if (proposal.status !== "active")
      return c.json({ error: "Proposal is not active" }, 400);
    if (new Date() >= new Date(proposal.endsAt))
      return c.json({ error: "Voting period has ended" }, 400);

    // Check option valid
    const options = proposal.options as string[];
    if (optionIndex < 0 || optionIndex >= options.length)
      return c.json(
        { error: `Invalid option. Choose 0-${options.length - 1}` },
        400,
      );

    // Check $COUNCIL balance (vote weight)
    const balance = await getCouncilBalance(walletAddress);
    const minToVote = parseFloat(process.env.DAO_MIN_VOTE_BALANCE || "1");

    if (balance < minToVote) {
      return c.json(
        {
          error: `Need at least ${minToVote} $COUNCIL to vote`,
          yourBalance: balance,
          buyAt: "https://app.nad.fun/token/" + COUNCIL_TOKEN_ADDRESS,
        },
        403,
      );
    }

    // Check if already voted
    const existingVote = await prisma.daoVote.findUnique({
      where: {
        proposalId_walletAddress: {
          proposalId,
          walletAddress: walletAddress.toLowerCase(),
        },
      },
    });

    if (existingVote) {
      // Update vote (change option)
      await prisma.daoVote.update({
        where: { id: existingVote.id },
        data: {
          optionIndex,
          weight: balance,
        },
      });

      console.log(
        `🗳️ Vote updated: ${walletAddress.slice(0, 8)}... → "${options[optionIndex]}" (${balance.toFixed(0)} weight)`,
      );

      return c.json({
        success: true,
        message: "Vote updated",
        vote: {
          option: options[optionIndex],
          weight: Math.round(balance * 100) / 100,
          updated: true,
        },
      });
    }

    // Create new vote
    await prisma.daoVote.create({
      data: {
        proposalId,
        walletAddress: walletAddress.toLowerCase(),
        optionIndex,
        weight: balance,
      },
    });

    // Update proposal counters
    await prisma.daoProposal.update({
      where: { id: proposalId },
      data: {
        totalVotes: { increment: 1 },
        totalWeight: { increment: balance },
      },
    });

    console.log(
      `🗳️ New vote: ${walletAddress.slice(0, 8)}... → "${options[optionIndex]}" (${balance.toFixed(0)} weight)`,
    );

    return c.json({
      success: true,
      message: "Vote cast",
      vote: {
        option: options[optionIndex],
        weight: Math.round(balance * 100) / 100,
      },
    });
  } catch (error) {
    console.error("Error casting vote:", error);
    return c.json({ error: "Failed to cast vote" }, 500);
  }
});

// ============================================================
// GET /api/dao/my-votes?wallet=0x... — Get user's votes
// ============================================================

daoRouter.get("/my-votes", async (c) => {
  try {
    const wallet = c.req.query("wallet");
    if (!wallet) return c.json({ error: "wallet param required" }, 400);

    const votes = await prisma.daoVote.findMany({
      where: { walletAddress: wallet.toLowerCase() },
      include: {
        proposal: {
          select: { title: true, options: true, status: true, endsAt: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return c.json({
      votes: votes.map((v: any) => ({
        proposalId: v.proposalId,
        proposalTitle: v.proposal.title,
        option: (v.proposal.options as string[])[v.optionIndex],
        optionIndex: v.optionIndex,
        weight: v.weight,
        votedAt: v.createdAt,
        proposalStatus:
          v.proposal.status === "active" &&
          new Date() < new Date(v.proposal.endsAt)
            ? "active"
            : "closed",
      })),
      count: votes.length,
    });
  } catch (error) {
    console.error("Error fetching votes:", error);
    return c.json({ error: "Failed to fetch votes" }, 500);
  }
});

// ============================================================
// POST /api/dao/proposals/:id/close — Close a proposal (admin)
// ============================================================

daoRouter.post("/proposals/:id/close", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();
    const { walletAddress } = body;

    if (!walletAddress || !isAdmin(walletAddress)) {
      return c.json({ error: "Admin only" }, 403);
    }

    const proposal = await prisma.daoProposal.findUnique({ where: { id } });
    if (!proposal) return c.json({ error: "Proposal not found" }, 404);

    await prisma.daoProposal.update({
      where: { id },
      data: { status: "closed" },
    });

    return c.json({ success: true, message: "Proposal closed" });
  } catch (error) {
    console.error("Error closing proposal:", error);
    return c.json({ error: "Failed to close proposal" }, 500);
  }
});

export default daoRouter;
