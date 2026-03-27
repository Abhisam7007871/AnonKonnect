import AnonKonnectApp from "@/components/anonkonnect-app";
import { fallbackStore } from "@/lib/fallback-store";
import { prisma } from "@/lib/prisma";

async function getInitialRooms() {
  if (!process.env.DATABASE_URL) {
    return fallbackStore.rooms;
  }

  const rooms = await prisma.room.findMany({
    where: {
      isPrivate: false,
    },
    orderBy: {
      createdAt: "desc",
    },
    include: {
      members: {
        where: {
          status: "ACTIVE",
        },
      },
    },
  });

  return rooms.map((room) => ({
    id: room.id,
    slug: room.slug,
    name: room.name,
    description: room.description,
    category: room.category,
    region: room.region,
    isPrivate: room.isPrivate,
    requiresAccess: room.requiresAccess,
    memberCount: room.members.length,
  }));
}

export default async function Page() {
  const initialRooms = await getInitialRooms();

  return <AnonKonnectApp initialRooms={initialRooms} />;
}
