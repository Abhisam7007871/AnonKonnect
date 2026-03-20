"use client";

import { motion } from "framer-motion";
import { City, Country, State } from "country-state-city";
import {
  Bot,
  Camera,
  ChevronRight,
  CircleDot,
  DoorOpen,
  Globe,
  ImagePlus,
  Lock,
  LogIn,
  Mic,
  MessageCircleMore,
  Radio,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  UserPlus,
  Users,
  Volume2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AdSensePlaceholder } from "@/components/adsense-placeholder";
import { ChatBubble } from "@/components/chat-bubble";
import { aiPersonas, buildPersonaIntro, getPersonaConfig } from "@/lib/demo-ai";
import { getSocket, resetSocket } from "@/lib/socket-client";
import { cn, formatRelativeClock, toTitleCase } from "@/lib/utils";

const tabs = [
  { id: "match", label: "1-on-1 Match", icon: Search },
  { id: "rooms", label: "Rooms", icon: Users },
  { id: "ai", label: "AI Personas", icon: Bot },
];

const modeOptions = [
  { id: "text", label: "Text", icon: MessageCircleMore },
  { id: "audio", label: "Audio", icon: Volume2 },
  { id: "video", label: "Video", icon: Camera },
];

const rtcConfiguration = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ],
};

const guestSession = {
  accessLevel: "guest",
  token: null,
  user: {
    nickname: "Guest",
  },
};

const roomSeedMessages = [
  {
    id: "seed-1",
    senderName: "Pulse",
    senderId: "seed",
    kind: "text",
    content: "Welcome in. Keep it kind and jump into the conversation.",
    timestamp: Date.now(),
  },
];

const quickEmojis = ["😀", "😂", "😍", "🔥", "🎉", "👋", "🤝", "✨"];
const stickerPack = [
  { label: "Celebrate", content: "🎉" },
  { label: "Love", content: "💖" },
  { label: "Laugh", content: "🤣" },
  { label: "Hype", content: "🚀" },
];

const allCountries = Country.getAllCountries()
  .map((country) => ({
    name: country.name,
    isoCode: country.isoCode,
  }))
  .sort((left, right) => left.name.localeCompare(right.name));

function toOnboardingFromUser(user = {}) {
  return {
    nickname: user.nickname || "",
    gender: user.gender || "",
    purpose: user.purpose || "chat",
    country: user.country || "United States",
    state: user.state || "",
    city: user.city || "",
  };
}

function persistSession(nextSession) {
  window.localStorage.setItem("anonkonnect-session", JSON.stringify(nextSession));
}

function createMessage(payload) {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    readAt: null,
    ...payload,
  };
}

export default function AnonKonnectApp({ initialRooms }) {
  const [activeTab, setActiveTab] = useState("match");
  const [session, setSession] = useState(guestSession);
  const [authMode, setAuthMode] = useState("login");
  const [authForm, setAuthForm] = useState({ email: "", password: "" });
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [authError, setAuthError] = useState("");
  const [composerActionError, setComposerActionError] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [socketId, setSocketId] = useState("");
  const [selectedMode, setSelectedMode] = useState("text");
  const [queueStatus, setQueueStatus] = useState(null);
  const [matchState, setMatchState] = useState({
    sessionId: "",
    peerId: "",
    peer: null,
    mode: "text",
    typing: false,
  });
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [onboarding, setOnboarding] = useState({
    nickname: "",
    gender: "",
    purpose: "chat",
    country: "United States",
    state: "California",
    city: "Los Angeles",
  });
  const [rooms, setRooms] = useState(initialRooms);
  const [activeRoom, setActiveRoom] = useState(null);
  const [roomMessages, setRoomMessages] = useState(roomSeedMessages);
  const [roomDraft, setRoomDraft] = useState("");
  const [roomTyping, setRoomTyping] = useState(false);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [newRoom, setNewRoom] = useState({
    name: "",
    description: "",
    category: "Interests",
    region: "Global",
    isPrivate: false,
  });
  const [privateRoomKey, setPrivateRoomKey] = useState("");
  const [aiPersonaId, setAiPersonaId] = useState("general");
  const [aiDraft, setAiDraft] = useState("");
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiMessages, setAiMessages] = useState([
    createMessage({
      id: "ai-intro",
      senderId: "assistant",
      senderName: "General Assistant",
      kind: "text",
      content: getPersonaConfig("general").intro,
    }),
  ]);
  const [gifUrl, setGifUrl] = useState("");
  const [roomGifUrl, setRoomGifUrl] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const typingTimeoutRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const screenShareStreamRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const matchSessionRef = useRef({ sessionId: "", peerId: "", mode: "text" });
  const [callError, setCallError] = useState("");
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCameraEnabled, setIsCameraEnabled] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [hasRemoteMedia, setHasRemoteMedia] = useState(false);

  const currentCountry = useMemo(
    () => allCountries.find((country) => country.name === onboarding.country) || allCountries[0],
    [onboarding.country],
  );
  const stateRecords = useMemo(
    () => (currentCountry ? State.getStatesOfCountry(currentCountry.isoCode) : []),
    [currentCountry],
  );
  const currentState = useMemo(
    () => stateRecords.find((state) => state.name === onboarding.state) || stateRecords[0] || null,
    [stateRecords, onboarding.state],
  );
  const stateOptions = stateRecords.map((state) => state.name);
  const cityOptions = useMemo(() => {
    if (!currentCountry || !currentState) {
      return [];
    }

    const scopedCities = City.getCitiesOfState(currentCountry.isoCode, currentState.isoCode).map(
      (city) => city.name,
    );
    if (scopedCities.length > 0) {
      return scopedCities;
    }

    return City.getCitiesOfCountry(currentCountry.isoCode).map((city) => city.name);
  }, [currentCountry, currentState]);
  const isRegistered = session.accessLevel === "registered";
  const queueCountdown = queueStatus?.nextExpansionAt
    ? formatRelativeClock(queueStatus.nextExpansionAt)
    : "01:00";

  function attachMedia(videoElement, stream, muted = false) {
    if (!videoElement) {
      return;
    }

    if (videoElement.srcObject !== stream) {
      videoElement.srcObject = stream || null;
    }

    videoElement.muted = muted;
    if (stream) {
      videoElement
        .play()
        .catch(() => {});
    }
  }

  function stopStream(stream) {
    stream?.getTracks().forEach((track) => track.stop());
  }

  function resetMatchMedia() {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.onconnectionstatechange = null;
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    stopStream(localStreamRef.current);
    stopStream(screenShareStreamRef.current);
    localStreamRef.current = null;
    screenShareStreamRef.current = null;
    remoteStreamRef.current = null;
    setIsMicMuted(false);
    setIsCameraEnabled(true);
    setIsScreenSharing(false);
    setHasRemoteMedia(false);
    setCallError("");
    attachMedia(localVideoRef.current, null, true);
    attachMedia(remoteVideoRef.current, null, false);
  }

  async function ensureLocalMedia(mode = matchSessionRef.current.mode) {
    if (mode === "text") {
      return null;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Realtime media is not supported in this browser.");
    }

    const needsVideo = mode === "video";
    const activeStream = localStreamRef.current;
    const hasAudio = activeStream?.getAudioTracks().length > 0;
    const hasVideo = activeStream?.getVideoTracks().length > 0;

    if (activeStream && hasAudio && (!needsVideo || hasVideo)) {
      return activeStream;
    }

    stopStream(activeStream);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: needsVideo,
    });

    localStreamRef.current = stream;
    setIsMicMuted(false);
    setIsCameraEnabled(needsVideo);
    attachMedia(localVideoRef.current, stream, true);
    return stream;
  }

  async function ensurePeerConnection(mode = matchSessionRef.current.mode) {
    if (peerConnectionRef.current) {
      return peerConnectionRef.current;
    }

    const pc = new RTCPeerConnection(rtcConfiguration);
    const stream = await ensureLocalMedia(mode);

    if (stream) {
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    }

    remoteStreamRef.current = new MediaStream();
    attachMedia(remoteVideoRef.current, remoteStreamRef.current, false);

    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (remoteStream) {
        remoteStreamRef.current = remoteStream;
      } else if (remoteStreamRef.current && event.track) {
        remoteStreamRef.current.addTrack(event.track);
      }
      setHasRemoteMedia(true);
      attachMedia(remoteVideoRef.current, remoteStreamRef.current, false);
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate || !matchSessionRef.current.sessionId || !matchSessionRef.current.peerId) {
        return;
      }

      getSocket().emit("ice-candidate", {
        to: matchSessionRef.current.peerId,
        sessionId: matchSessionRef.current.sessionId,
        candidate: event.candidate,
      });
    };

    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        setHasRemoteMedia(false);
      }
    };

    peerConnectionRef.current = pc;
    return pc;
  }

  async function renegotiateMatchConnection() {
    if (!peerConnectionRef.current || !matchSessionRef.current.sessionId || !matchSessionRef.current.peerId) {
      return;
    }

    const pc = await ensurePeerConnection(matchSessionRef.current.mode);
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    getSocket().emit("offer", {
      to: matchSessionRef.current.peerId,
      sessionId: matchSessionRef.current.sessionId,
      offer: pc.localDescription,
    });
  }

  useEffect(() => {
    const persona = getPersonaConfig(aiPersonaId);
    setAiMessages([
      createMessage({
        id: `ai-intro-${persona.id}`,
        senderId: "assistant",
        senderName: persona.name,
        kind: "text",
        content: buildPersonaIntro(persona.id),
      }),
    ]);
  }, [aiPersonaId]);

  useEffect(() => {
    const stored = window.localStorage.getItem("anonkonnect-session");

    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setSession(parsed);
        setOnboarding((current) => ({
          ...current,
          ...toOnboardingFromUser(parsed.user),
        }));
      } catch {
        window.localStorage.removeItem("anonkonnect-session");
      }
    }
  }, []);

  useEffect(() => {
    async function hydrateProfile() {
      if (!session.token || session.accessLevel !== "registered") {
        return;
      }

      const response = await fetch("/api/profile", {
        headers: {
          Authorization: `Bearer ${session.token}`,
        },
      });

      if (!response.ok) {
        window.localStorage.removeItem("anonkonnect-session");
        setSession(guestSession);
        return;
      }

      const payload = await response.json();
      const nextSession = {
        ...session,
        token: payload.token || session.token,
        user: payload.user,
      };
      persistSession(nextSession);
      setSession(nextSession);
      setOnboarding((current) => ({
        ...current,
        ...toOnboardingFromUser(payload.user),
      }));
    }

    hydrateProfile().catch(() => {});
  }, [session.token, session.accessLevel]);

  useEffect(() => {
    if (!currentCountry) {
      return;
    }

    if (stateOptions.length > 0 && !stateOptions.includes(onboarding.state)) {
      const nextState = stateOptions[0];
      setOnboarding((current) => ({
        ...current,
        state: nextState,
        city: "",
      }));
      return;
    }

    if (cityOptions.length > 0 && !cityOptions.includes(onboarding.city)) {
      setOnboarding((current) => ({
        ...current,
        city: cityOptions[0],
      }));
    }
  }, [currentCountry, onboarding.state, onboarding.city, stateOptions, cityOptions]);

  useEffect(() => {
    matchSessionRef.current = {
      sessionId: matchState.sessionId,
      peerId: matchState.peerId,
      mode: matchState.mode,
    };
  }, [matchState.sessionId, matchState.peerId, matchState.mode]);

  useEffect(() => {
    if (!matchState.sessionId || !matchState.peerId || matchState.mode === "text" || !socketId) {
      if (!matchState.sessionId) {
        resetMatchMedia();
      }
      return;
    }

    let cancelled = false;

    async function startRealtimeMedia() {
      try {
        await ensurePeerConnection(matchState.mode);
        if (cancelled) {
          return;
        }

        const shouldInitiate = socketId.localeCompare(matchState.peerId) < 0;
        if (shouldInitiate) {
          await renegotiateMatchConnection();
        }
      } catch (error) {
        setCallError(error.message || "Unable to start realtime media.");
      }
    }

    startRealtimeMedia().catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [matchState.sessionId, matchState.peerId, matchState.mode, socketId]);

  useEffect(() => {
    resetSocket();
    const socket = getSocket({
      token: session.token,
      user: session.user,
      accessLevel: session.accessLevel,
    });
    socket.connect();

    socket.on("connect", () => {
      setIsConnected(true);
      socket.emit("list_rooms");
    });
    socket.on("disconnect", () => setIsConnected(false));
    socket.on("connected", (payload) => setSocketId(payload.userId));
    socket.on("queue-update", (payload) => setQueueStatus(payload));
    socket.on("matched", (payload) => {
      resetMatchMedia();
      setQueueStatus(null);
      setSelectedMode(payload.mode || "text");
      setMatchState({
        sessionId: payload.sessionId,
        peerId: payload.peerId,
        peer: payload.peerProfile,
        mode: payload.mode || "text",
        typing: false,
      });
      setMessages([
        createMessage({
          senderId: payload.peerId,
          senderName: payload.peerProfile?.nickname || "Anon",
          kind: "text",
          content: `Connected in ${toTitleCase(payload.matchTier)} mode. Say hi.`,
        }),
      ]);
      setActiveTab("match");
    });
    socket.on("chat-message", (payload) => {
      setMessages((current) => [...current, payload.message]);
      if (payload.sessionId) {
        socket.emit("message-read", {
          to: payload.from,
          sessionId: payload.sessionId,
          messageId: payload.message.id,
        });
      }
    });
    socket.on("typing", ({ isTyping }) => {
      setMatchState((current) => ({ ...current, typing: isTyping }));
    });
    socket.on("message-read", ({ messageId, readAt }) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId ? { ...message, readAt } : message,
        ),
      );
    });
    socket.on("offer", async ({ offer, sessionId }) => {
      if (!matchSessionRef.current.sessionId || sessionId !== matchSessionRef.current.sessionId) {
        return;
      }

      try {
        const pc = await ensurePeerConnection(matchSessionRef.current.mode);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("answer", {
          to: matchSessionRef.current.peerId,
          sessionId,
          answer: pc.localDescription,
        });
      } catch (error) {
        setCallError(error.message || "Unable to answer the incoming call.");
      }
    });
    socket.on("answer", async ({ answer, sessionId }) => {
      if (!peerConnectionRef.current || sessionId !== matchSessionRef.current.sessionId) {
        return;
      }

      try {
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (error) {
        setCallError(error.message || "Unable to connect the remote stream.");
      }
    });
    socket.on("ice-candidate", async ({ candidate, sessionId }) => {
      if (!peerConnectionRef.current || sessionId !== matchSessionRef.current.sessionId || !candidate) {
        return;
      }

      try {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // Ignore late ICE for torn-down sessions.
      }
    });
    socket.on("rooms_snapshot", (payload) => {
      setRooms(payload.rooms);
      setPendingRequests(payload.pendingRequests || []);
    });
    socket.on("room_joined", (payload) => {
      setActiveRoom(payload.room);
      setRoomMessages(payload.messages?.length ? payload.messages : roomSeedMessages);
      setActiveTab("rooms");
    });
    socket.on("room_message", (payload) => {
      setRoomMessages((current) => [...current, payload.message]);
      socket.emit("room_read", {
        roomId: payload.roomId,
        messageId: payload.message.id,
      });
    });
    socket.on("room_typing", ({ isTyping }) => setRoomTyping(isTyping));
    socket.on("room_message_read", ({ messageId, readAt }) => {
      setRoomMessages((current) =>
        current.map((message) =>
          message.id === messageId ? { ...message, readAt } : message,
        ),
      );
    });
    socket.on("room_access_requested", (payload) => {
      setPendingRequests((current) => [payload, ...current]);
      setActiveTab("rooms");
    });
    socket.on("room_request_resolved", (payload) => {
      setPendingRequests((current) =>
        current.filter((request) => request.requesterId !== payload.requesterId),
      );
    });
    socket.on("room_error", (payload) => {
      setAuthError(payload.message || "Room action failed.");
    });
    socket.on("session:skip", () => {
      resetMatchMedia();
      setMatchState({
        sessionId: "",
        peerId: "",
        peer: null,
        mode: "text",
        typing: false,
      });
      setMessages([]);
    });
    socket.on("session:partner_left", () => {
      resetMatchMedia();
      setMatchState({
        sessionId: "",
        peerId: "",
        peer: null,
        mode: "text",
        typing: false,
      });
    });
    socket.on("rooms_snapshot_broadcast", () => {
      socket.emit("list_rooms");
    });

    return () => {
      resetMatchMedia();
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [session]);

  async function reloadRooms() {
    const response = await fetch("/api/rooms");
    const payload = await response.json();
    setRooms(payload.rooms || []);
  }

  async function syncRegisteredProfile(overrides = {}) {
    if (!isRegistered || !session.token) {
      return session;
    }

    const response = await fetch("/api/profile", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({
        ...toOnboardingFromUser(session.user),
        ...onboarding,
        ...overrides,
      }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Unable to save your profile.");
    }

    const nextSession = {
      ...session,
      token: payload.token || session.token,
      user: payload.user,
    };
    persistSession(nextSession);
    setSession(nextSession);
    setOnboarding((current) => ({
      ...current,
      ...toOnboardingFromUser(payload.user),
    }));
    return nextSession;
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    setIsAuthLoading(true);
    setAuthError("");

    const endpoint = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
    const body =
      authMode === "login"
        ? authForm
        : {
            ...authForm,
            nickname: onboarding.nickname,
            gender: onboarding.gender,
            purpose: onboarding.purpose,
            country: onboarding.country,
            state: onboarding.state,
            city: onboarding.city,
          };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    setIsAuthLoading(false);

    if (!response.ok) {
      setAuthError(payload.error || "Unable to authenticate.");
      return;
    }

    const nextSession = {
      accessLevel: "registered",
      token: payload.token,
      user: payload.user,
    };
    persistSession(nextSession);
    setSession(nextSession);
    setOnboarding((current) => ({
      ...current,
      ...toOnboardingFromUser(payload.user),
    }));
    setAuthForm({ email: authForm.email, password: "" });
  }

  function continueAsGuest() {
    const nextSession = {
      ...guestSession,
      user: {
        nickname: onboarding.nickname || "Guest",
        gender: onboarding.gender,
        purpose: onboarding.purpose,
        country: onboarding.country,
        state: onboarding.state,
        city: onboarding.city,
      },
    };

    persistSession(nextSession);
    setSession(nextSession);
  }

  function logout() {
    window.localStorage.removeItem("anonkonnect-session");
    resetMatchMedia();
    setSession(guestSession);
    setActiveRoom(null);
    setMessages([]);
    setRoomMessages(roomSeedMessages);
  }

  async function joinMatchmakingQueue() {
    if (!isConnected) {
      setAuthError("Realtime server is reconnecting. Please wait until Socket status is Live.");
      return;
    }

    let nextSession = session;
    try {
      nextSession = await syncRegisteredProfile();
    } catch (error) {
      setAuthError(error.message);
      return;
    }

    const socket = getSocket();
    socket.emit("join-queue", {
      mode: selectedMode,
      profile: {
        ...nextSession.user,
        nickname: onboarding.nickname || nextSession.user.nickname || "Guest",
        gender: onboarding.gender,
        purpose: onboarding.purpose,
        country: onboarding.country,
        state: onboarding.state,
        city: onboarding.city,
        accessLevel: nextSession.accessLevel,
      },
    });
  }

  function addEmojiToComposer(emoji, target) {
    if (target === "match") {
      setDraft((current) => `${current}${emoji}`);
      return;
    }

    setRoomDraft((current) => `${current}${emoji}`);
  }

  function handleComposerEnter(event, onSubmit) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  }

  function sendMessage(kind = "text", content = draft) {
    if (!matchState.sessionId) {
      setComposerActionError("Start matching first to send messages, stickers, GIFs, images, or voice notes.");
      return;
    }

    const normalized = typeof content === "string" ? content.trim() : content;
    if (!normalized) {
      setComposerActionError(kind === "gif" ? "Paste a GIF URL first." : "Type something to send.");
      return;
    }

    setComposerActionError("");

    const socket = getSocket();
    const message = createMessage({
      senderId: socketId,
      senderName: onboarding.nickname || session.user.nickname || "You",
      kind,
      content,
    });
    setMessages((current) => [...current, message]);
    socket.emit("chat-message", {
      to: matchState.peerId,
      sessionId: matchState.sessionId,
      message,
    });
    setDraft("");
    setGifUrl("");
  }

  function sendRoomMessage(kind = "text", content = roomDraft) {
    if (!activeRoom?.id) {
      setComposerActionError("Join a room first to send messages, stickers, GIFs, images, or voice notes.");
      return;
    }

    const normalized = typeof content === "string" ? content.trim() : content;
    if (!normalized) {
      setComposerActionError(kind === "gif" ? "Paste a GIF URL first." : "Type something to send.");
      return;
    }

    setComposerActionError("");

    const socket = getSocket();
    const message = createMessage({
      senderId: socketId,
      senderName: onboarding.nickname || session.user.nickname || "You",
      kind,
      content,
    });
    setRoomMessages((current) => [...current, message]);
    socket.emit("room_message", {
      roomId: activeRoom.id,
      message,
    });
    setRoomDraft("");
    setRoomGifUrl("");
  }

  function onTypingChat() {
    const socket = getSocket();
    socket.emit("typing", {
      to: matchState.peerId,
      sessionId: matchState.sessionId,
      isTyping: true,
    });
    window.clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => {
      socket.emit("typing", {
        to: matchState.peerId,
        sessionId: matchState.sessionId,
        isTyping: false,
      });
    }, 1200);
  }

  function onRoomTyping() {
    const socket = getSocket();
    socket.emit("room_typing", {
      roomId: activeRoom.id,
      isTyping: true,
    });
    window.clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => {
      socket.emit("room_typing", {
        roomId: activeRoom.id,
        isTyping: false,
      });
    }, 1200);
  }

  async function createRoom() {
    if (!isConnected) {
      setAuthError("Realtime server is reconnecting. Please wait until Socket status is Live.");
      return;
    }

    if (!isRegistered) {
      setAuthError("Register or log in to create private rooms.");
      return;
    }

    let nextSession = session;
    try {
      nextSession = await syncRegisteredProfile();
    } catch (error) {
      setAuthError(error.message);
      return;
    }

    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${nextSession.token}`,
      },
      body: JSON.stringify(newRoom),
    });
    const payload = await response.json();

    if (!response.ok) {
      setAuthError(payload.error || "Unable to create room.");
      return;
    }

    const socket = getSocket();
    socket.emit("create_room", {
      room: payload.room,
      profile: {
        ...nextSession.user,
        nickname: onboarding.nickname || nextSession.user.nickname,
      },
    });
    setNewRoom({
      name: "",
      description: "",
      category: "Interests",
      region: "Global",
      isPrivate: false,
    });
    reloadRooms();
  }

  async function joinRoom(room) {
    if (!isConnected) {
      setAuthError("Realtime server is reconnecting. Please wait until Socket status is Live.");
      return;
    }

    let nextSession = session;
    if (isRegistered) {
      try {
        nextSession = await syncRegisteredProfile();
      } catch (error) {
        setAuthError(error.message);
        return;
      }
    }

    const socket = getSocket();
    const profile = {
      ...nextSession.user,
      nickname: onboarding.nickname || nextSession.user.nickname || "Guest",
      accessLevel: nextSession.accessLevel,
    };

    if (room.isPrivate) {
      socket.emit("request_join_room", { roomId: room.id, profile });
      return;
    }

    socket.emit("join_public_room", { roomId: room.id, profile });
  }

  async function requestPrivateRoom() {
    if (!isConnected) {
      setAuthError("Realtime server is reconnecting. Please wait until Socket status is Live.");
      return;
    }

    if (!privateRoomKey.trim()) {
      return;
    }

    let nextSession = session;
    if (isRegistered) {
      try {
        nextSession = await syncRegisteredProfile();
      } catch (error) {
        setAuthError(error.message);
        return;
      }
    }

    const socket = getSocket();
    socket.emit("request_join_room", {
      roomId: privateRoomKey.trim(),
      profile: {
        ...nextSession.user,
        nickname: onboarding.nickname || nextSession.user.nickname || "Guest",
        accessLevel: nextSession.accessLevel,
      },
    });
    setPrivateRoomKey("");
  }

  function resolveAccessRequest(request, decision) {
    if (!isConnected) {
      setAuthError("Realtime server is reconnecting. Please wait until Socket status is Live.");
      return;
    }

    const socket = getSocket();
    socket.emit("respond_room_request", {
      roomId: request.roomId,
      requesterId: request.requesterId,
      decision,
    });
  }

  function openAiChannel(personaId) {
    setAiPersonaId(personaId);
    const persona = getPersonaConfig(personaId);
    setAiMessages([
      createMessage({
        id: `ai-intro-${personaId}-${crypto.randomUUID()}`,
        senderId: "assistant",
        senderName: persona.name,
        kind: "text",
        content: buildPersonaIntro(personaId),
      }),
    ]);
  }

  async function sendAiPrompt() {
    if (!aiDraft.trim() || isAiLoading) {
      return;
    }

    const prompt = createMessage({
      senderId: "me",
      senderName: session.user.nickname || "You",
      kind: "text",
      content: aiDraft,
    });
    const nextMessages = [...aiMessages, prompt];
    setAiMessages(nextMessages);
    setAiDraft("");
    setIsAiLoading(true);

    try {
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personaId: aiPersonaId,
          message: prompt.content,
          userGender: onboarding.gender,
          history: nextMessages
            .filter((message) => !String(message.id || "").startsWith("ai-intro"))
            .slice(-10)
            .map((message) => ({
              role: message.senderId === "me" ? "user" : "assistant",
              content: message.content,
            })),
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setAiMessages((current) => [
          ...current,
          createMessage({
            senderId: "assistant",
            senderName: getPersonaConfig(aiPersonaId).name,
            kind: "text",
            content: payload.error || "The AI request failed.",
          }),
        ]);
        return;
      }

      setAiMessages((current) => [
        ...current,
        createMessage({
          senderId: aiPersonaId,
          senderName: aiPersonas.find((persona) => persona.id === aiPersonaId)?.name || "AI",
          kind: "text",
          content: payload.reply,
        }),
      ]);
    } catch {
      setAiMessages((current) => [
        ...current,
        createMessage({
          senderId: "assistant",
          senderName: getPersonaConfig(aiPersonaId).name,
          kind: "text",
          content: "Unable to reach the AI provider right now.",
        }),
      ]);
    } finally {
      setIsAiLoading(false);
    }
  }

  function attachImage(event, target) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (target === "match") {
        sendMessage("image", reader.result);
      } else {
        sendRoomMessage("image", reader.result);
      }
    };
    reader.readAsDataURL(file);
  }

  async function toggleVoiceNote(target) {
    if (!("MediaRecorder" in window)) {
      setAuthError("Voice notes need MediaRecorder support in your browser.");
      return;
    }

    if (isRecording && recorderRef.current) {
      recorderRef.current.stop();
      setIsRecording(false);
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      chunksRef.current.push(event.data);
    };
    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      const reader = new FileReader();
      reader.onload = () => {
        if (target === "match") {
          sendMessage("voice", reader.result);
        } else {
          sendRoomMessage("voice", reader.result);
        }
      };
      reader.readAsDataURL(blob);

      stream.getTracks().forEach((track) => track.stop());
    };
    recorder.start();
    recorderRef.current = recorder;
    setIsRecording(true);
  }

  function toggleMic() {
    const audioTrack = localStreamRef.current?.getAudioTracks()?.[0];
    if (!audioTrack) {
      return;
    }

    audioTrack.enabled = !audioTrack.enabled;
    setIsMicMuted(!audioTrack.enabled);
  }

  function toggleCamera() {
    const videoTrack = localStreamRef.current?.getVideoTracks()?.[0];
    if (!videoTrack) {
      return;
    }

    videoTrack.enabled = !videoTrack.enabled;
    setIsCameraEnabled(videoTrack.enabled);
  }

  async function toggleScreenShare() {
    if (matchState.mode !== "video" || !navigator.mediaDevices?.getDisplayMedia) {
      return;
    }

    const pc = await ensurePeerConnection("video");
    const screenTrack = screenShareStreamRef.current?.getVideoTracks()?.[0];
    const videoSender = pc.getSenders().find((sender) => sender.track?.kind === "video");

    if (screenTrack && videoSender) {
      const cameraTrack = localStreamRef.current?.getVideoTracks()?.[0] || null;
      await videoSender.replaceTrack(cameraTrack);
      stopStream(screenShareStreamRef.current);
      screenShareStreamRef.current = null;
      setIsScreenSharing(false);
      attachMedia(localVideoRef.current, localStreamRef.current, true);
      await renegotiateMatchConnection();
      return;
    }

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const nextTrack = screenStream.getVideoTracks()[0];
      if (!nextTrack || !videoSender) {
        return;
      }

      nextTrack.onended = () => {
        if (screenShareStreamRef.current) {
          toggleScreenShare().catch(() => {});
        }
      };
      await videoSender.replaceTrack(nextTrack);
      screenShareStreamRef.current = screenStream;
      setIsScreenSharing(true);
      attachMedia(localVideoRef.current, screenStream, true);
      await renegotiateMatchConnection();
    } catch (error) {
      setCallError(error.message || "Unable to share your screen.");
    }
  }

  function skipCurrentMatch() {
    if (!matchState.sessionId) {
      return;
    }

    getSocket().emit("skip", { sessionId: matchState.sessionId });
  }

  function leaveCurrentMatch() {
    if (!matchState.sessionId) {
      return;
    }

    getSocket().emit("leave_session", { sessionId: matchState.sessionId });
    resetMatchMedia();
    setMatchState({
      sessionId: "",
      peerId: "",
      peer: null,
      mode: "text",
      typing: false,
    });
    setMessages([]);
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-[linear-gradient(180deg,#f8fbff_0%,#eef5ff_46%,#e8f1ff_100%)] text-slate-900">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(79,124,255,0.28),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(139,92,246,0.2),_transparent_22%),linear-gradient(180deg,_#020617_0%,_#070b17_44%,_#020617_100%)]" />
      <div className="pointer-events-none absolute left-8 top-10 h-56 w-56 rounded-full bg-electric/20 blur-3xl" />
      <div className="pointer-events-none absolute bottom-12 right-10 h-72 w-72 rounded-full bg-violet/20 blur-3xl" />

      <div className="relative mx-auto flex min-h-screen max-w-[1600px] flex-col px-4 py-4 sm:px-6 lg:px-8">
        <header className="mb-4 rounded-[32px] border border-slate-200/80 bg-white/80 px-5 py-4 backdrop-blur-xl">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-electric to-violet text-white shadow-glass">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Premium Realtime Platform</p>
                  <h1 className="text-2xl font-semibold">AnonKonnect</h1>
                </div>
              </div>
              <p className="mt-3 max-w-2xl text-sm text-slate-600">
                Glassmorphism matchmaking, gated rooms, and AI personas in one dark-mode-first experience.
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-[1fr_280px]">
              <AdSensePlaceholder label="Header leaderboard unit for premium monetization." />
              <div className="flex items-center justify-between rounded-3xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm backdrop-blur-xl">
                <div>
                  <p className="text-slate-500">Socket status</p>
                  <p className="flex items-center gap-2 font-medium text-slate-900">
                    <CircleDot className={cn("h-4 w-4", isConnected ? "text-aqua" : "text-rose-400")} />
                    {isConnected ? "Live" : "Reconnecting"}
                  </p>
                </div>
                <button
                  className="rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-slate-900 transition hover:bg-white/90"
                  onClick={logout}
                  type="button"
                >
                  {isRegistered ? "Logout" : "Reset Guest"}
                </button>
              </div>
            </div>
          </div>
        </header>

        <div className="grid flex-1 gap-4 xl:grid-cols-[300px_minmax(0,1fr)_320px]">
          <aside className="space-y-4">
            <motion.div
              animate={{ y: [0, -6, 0] }}
              className="rounded-[30px] border border-slate-200/80 bg-white/80 p-5 backdrop-blur-xl"
              transition={{ duration: 8, repeat: Number.POSITIVE_INFINITY }}
            >
              <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Identity + Access</p>
              <div className="mt-4 rounded-3xl border border-slate-200/80 bg-white/75 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-lg font-semibold">{onboarding.nickname || session.user.nickname || "Anonymous"}</p>
                    <p className="text-sm text-slate-500">
                      {isRegistered ? "Registered access" : "Guest preview mode"}
                    </p>
                  </div>
                  {isRegistered ? (
                    <ShieldCheck className="h-6 w-6 text-aqua" />
                  ) : (
                    <Lock className="h-6 w-6 text-amber-300" />
                  )}
                </div>
                <p className="mt-3 text-sm text-slate-600">
                  Guests can browse public rooms, but room names and messages stay blurred until they register.
                </p>
              </div>

              <form className="mt-4 space-y-3" onSubmit={handleAuthSubmit}>
                <div className="grid grid-cols-2 gap-2 rounded-2xl border border-slate-200/80 bg-slate-100/80 p-1">
                  <button
                    className={cn(
                      "rounded-xl px-3 py-2 text-sm transition",
                      authMode === "login" ? "bg-white/90 text-slate-900" : "text-slate-500",
                    )}
                    onClick={() => setAuthMode("login")}
                    type="button"
                  >
                    Login
                  </button>
                  <button
                    className={cn(
                      "rounded-xl px-3 py-2 text-sm transition",
                      authMode === "register" ? "bg-white/90 text-slate-900" : "text-slate-500",
                    )}
                    onClick={() => setAuthMode("register")}
                    type="button"
                  >
                    Register
                  </button>
                </div>
                <input
                  className="w-full rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm outline-none ring-0 placeholder:text-slate-500"
                  onChange={(event) =>
                    setAuthForm((current) => ({ ...current, email: event.target.value }))
                  }
                  placeholder="Email"
                  type="email"
                  value={authForm.email}
                />
                <input
                  className="w-full rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm outline-none ring-0 placeholder:text-slate-500"
                  onChange={(event) =>
                    setAuthForm((current) => ({ ...current, password: event.target.value }))
                  }
                  placeholder="Password"
                  type="password"
                  value={authForm.password}
                />
                <div className="grid grid-cols-2 gap-2">
                  <button
                  className="inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-electric to-violet px-4 py-3 text-sm font-medium text-white"
                    disabled={isAuthLoading}
                    type="submit"
                  >
                    {authMode === "login" ? <LogIn className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />}
                    {isAuthLoading ? "Working..." : authMode === "login" ? "Login" : "Register"}
                  </button>
                  <button
                    className="rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm"
                    onClick={continueAsGuest}
                    type="button"
                  >
                    Guest Mode
                  </button>
                </div>
                {authError && <p className="text-sm text-rose-300">{authError}</p>}
              </form>
            </motion.div>

            <AdSensePlaceholder label="Sidebar skyscraper unit beside active conversations." />
          </aside>

          <main className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
              <section className="rounded-[32px] border border-slate-200/80 bg-white/80 p-5 backdrop-blur-xl">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Onboarding</p>
                    <h2 className="mt-1 text-xl font-semibold">Tell AnonKonnect who you want to meet</h2>
                  </div>
                  <div className="inline-flex rounded-2xl border border-slate-200/80 bg-slate-100/80 p-1">
                    {tabs.map((tab) => {
                      const Icon = tab.icon;
                      return (
                        <button
                          key={tab.id}
                          className={cn(
                            "inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm transition",
                            activeTab === tab.id ? "bg-white/90 text-slate-900" : "text-slate-500",
                          )}
                          onClick={() => setActiveTab(tab.id)}
                          type="button"
                        >
                          <Icon className="h-4 w-4" />
                          {tab.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="mt-5 grid gap-3 md:grid-cols-2">
                  <input
                    className="rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm placeholder:text-slate-500"
                    onChange={(event) =>
                      setOnboarding((current) => ({ ...current, nickname: event.target.value }))
                    }
                    placeholder="Nickname"
                    value={onboarding.nickname}
                  />
                  <select
                    className="rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm"
                    onChange={(event) =>
                      setOnboarding((current) => ({ ...current, gender: event.target.value }))
                    }
                    value={onboarding.gender}
                  >
                    <option value="">Gender</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                    <option value="non-binary">Non-binary</option>
                    <option value="prefer-not-to-say">Prefer not to say</option>
                  </select>
                  <select
                    className="rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm"
                    onChange={(event) =>
                      setOnboarding((current) => ({ ...current, purpose: event.target.value }))
                    }
                    value={onboarding.purpose}
                  >
                    <option value="dating">Dating</option>
                    <option value="friendship">Friendship</option>
                    <option value="chat">Chat</option>
                  </select>
                  <select
                    className="rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm"
                    onChange={(event) =>
                      setOnboarding((current) => ({ ...current, country: event.target.value }))
                    }
                    value={onboarding.country}
                  >
                    {allCountries.map((country) => (
                      <option key={country.name} value={country.name}>
                        {country.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm"
                    disabled={stateOptions.length === 0}
                    onChange={(event) =>
                      setOnboarding((current) => ({ ...current, state: event.target.value }))
                    }
                    value={onboarding.state}
                  >
                    {stateOptions.length === 0 ? <option value="">No states available</option> : null}
                    {stateOptions.map((state) => (
                      <option key={state} value={state}>
                        {state}
                      </option>
                    ))}
                  </select>
                  <select
                    className="rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm"
                    disabled={cityOptions.length === 0}
                    onChange={(event) =>
                      setOnboarding((current) => ({ ...current, city: event.target.value }))
                    }
                    value={onboarding.city}
                  >
                    {cityOptions.length === 0 ? <option value="">No cities available</option> : null}
                    {cityOptions.map((city) => (
                      <option key={city} value={city}>
                        {city}
                      </option>
                    ))}
                  </select>
                </div>
              </section>

              <section className="rounded-[32px] border border-slate-200/80 bg-white/80 p-5 backdrop-blur-xl">
                <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Match Flow</p>
                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  {modeOptions.map((mode) => {
                    const Icon = mode.icon;
                    return (
                      <button
                        key={mode.id}
                        className={cn(
                          "rounded-3xl border p-4 text-left transition",
                          selectedMode === mode.id
                            ? "border-electric/40 bg-electric/15"
                            : "border-slate-200/80 bg-white/80",
                        )}
                        onClick={() => setSelectedMode(mode.id)}
                        type="button"
                      >
                        <Icon className="h-5 w-5 text-aqua" />
                        <p className="mt-4 font-medium">{mode.label}</p>
                        <p className="mt-1 text-sm text-slate-500">
                          {mode.id === "text"
                            ? "Fastest route into a live conversation."
                            : mode.id === "audio"
                              ? "Voice-first queue with media support."
                              : "Full-presence experience with premium feel."}
                        </p>
                      </button>
                    );
                  })}
                </div>

                <button
                  className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-electric to-violet px-4 py-3 font-medium text-white"
                  onClick={joinMatchmakingQueue}
                  type="button"
                >
                  <Radio className="h-4 w-4" />
                  Start Matching
                </button>

                <div className="mt-4 rounded-3xl border border-slate-200/80 bg-white/75 p-4">
                  <div className="flex items-center justify-between text-sm">
                    <p className="text-slate-600">
                      {queueStatus?.message || `Searching for matches in ${onboarding.country}...`}
                    </p>
                    <span className="rounded-full bg-white/80 px-3 py-1 text-xs text-slate-600">
                      {queueCountdown}
                    </span>
                  </div>
                  <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/80">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-aqua to-electric"
                      style={{
                        width: queueStatus?.progressPercent ? `${queueStatus.progressPercent}%` : "8%",
                      }}
                    />
                  </div>
                  <div className="mt-4 flex items-center gap-4 text-xs text-slate-500">
                    <span className="inline-flex items-center gap-2">
                      <Globe className="h-3.5 w-3.5" />
                      {queueStatus?.stage ? toTitleCase(queueStatus.stage) : "Country"}
                    </span>
                    <span>{queueStatus?.totalInQueue || 0} people in queue</span>
                  </div>
                </div>
              </section>
            </div>

            <AdSensePlaceholder label="Inline ad unit between discovery modules and active chat." />

            {activeTab === "match" && (
              <section className="grid gap-4 xl:grid-cols-[0.88fr_1.12fr]">
                <div className="rounded-[32px] border border-slate-200/80 bg-white/80 p-5 backdrop-blur-xl">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Current Connection</p>
                      <h3 className="mt-1 text-xl font-semibold">
                        {matchState.peer?.nickname || "Waiting for your next match"}
                      </h3>
                    </div>
                    <div className="rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-sm text-slate-600">
                      {matchState.peer?.country || onboarding.country}
                    </div>
                  </div>
                  <div className="mt-4 space-y-3 text-sm text-slate-600">
                    <div className="rounded-3xl border border-slate-200/80 bg-white/75 p-4">
                      <p className="font-medium text-slate-900">Matching priorities</p>
                      <p className="mt-2">1. Same country</p>
                      <p>2. Nearby countries</p>
                      <p>3. Global fallback</p>
                    </div>
                    <div className="rounded-3xl border border-slate-200/80 bg-white/75 p-4">
                      <p className="font-medium text-slate-900">Realtime touches</p>
                      <p className="mt-2">Typing indicators, read receipts, images, GIFs, and voice notes are live.</p>
                    </div>
                  </div>
                </div>

                <div className="rounded-[32px] border border-slate-200/80 bg-white/80 p-5 backdrop-blur-xl">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Live Chat</p>
                      <h3 className="mt-1 text-xl font-semibold">Premium one-on-one feed</h3>
                    </div>
                    {matchState.typing && <p className="text-sm text-aqua">typing...</p>}
                  </div>
                  {matchState.mode !== "text" && (
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <div className="rounded-[28px] border border-slate-200/80 bg-white/80 p-3">
                        <p className="mb-2 text-xs uppercase tracking-[0.24em] text-slate-500">You</p>
                        <video
                          ref={localVideoRef}
                          autoPlay
                          className="aspect-video w-full rounded-3xl bg-slate-100 object-cover"
                          muted
                          playsInline
                        />
                      </div>
                      <div className="rounded-[28px] border border-slate-200/80 bg-white/80 p-3">
                        <p className="mb-2 text-xs uppercase tracking-[0.24em] text-slate-500">
                          {matchState.peer?.nickname || "Partner"}
                        </p>
                        <video
                          ref={remoteVideoRef}
                          autoPlay
                          className="aspect-video w-full rounded-3xl bg-slate-100 object-cover"
                          playsInline
                        />
                        {!hasRemoteMedia && (
                          <p className="mt-2 text-xs text-slate-500">Waiting for remote media...</p>
                        )}
                      </div>
                    </div>
                  )}
                  {callError && (
                    <div className="mt-4 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                      {callError}
                    </div>
                  )}
                  {matchState.sessionId && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {matchState.mode !== "text" && (
                        <button
                          className="rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-sm"
                          onClick={toggleMic}
                          type="button"
                        >
                          {isMicMuted ? "Unmute" : "Mute"}
                        </button>
                      )}
                      {matchState.mode === "video" && (
                        <>
                          <button
                            className="rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-sm"
                            onClick={toggleCamera}
                            type="button"
                          >
                            {isCameraEnabled ? "Camera Off" : "Camera On"}
                          </button>
                          <button
                            className="rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-sm"
                            onClick={() => toggleScreenShare()}
                            type="button"
                          >
                            {isScreenSharing ? "Stop Sharing" : "Share Screen"}
                          </button>
                        </>
                      )}
                      <button
                        className="rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-sm"
                        onClick={skipCurrentMatch}
                        type="button"
                      >
                        Skip
                      </button>
                      <button
                        className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100"
                        onClick={leaveCurrentMatch}
                        type="button"
                      >
                        Leave
                      </button>
                    </div>
                  )}
                  <div className="mt-4 h-[420px] space-y-3 overflow-y-auto rounded-[28px] border border-slate-200/80 bg-white/80 p-4">
                    {messages.length === 0 ? (
                      <div className="flex h-full items-center justify-center text-center text-sm text-slate-500">
                        Join the queue to start a realtime conversation.
                      </div>
                    ) : (
                      messages.map((message) => (
                        <ChatBubble
                          key={message.id}
                          isBlurred={false}
                          isOwn={message.senderId === socketId || message.senderId === "me"}
                          message={message}
                        />
                      ))
                    )}
                  </div>
                  <div className="mt-4 space-y-3">
                    {composerActionError ? (
                      <p className="text-sm text-rose-600">{composerActionError}</p>
                    ) : null}
                    <textarea
                      className="min-h-24 w-full rounded-3xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm placeholder:text-slate-500"
                      onChange={(event) => {
                        setDraft(event.target.value);
                        onTypingChat();
                      }}
                      onKeyDown={(event) => handleComposerEnter(event, () => sendMessage("text"))}
                      placeholder="Type a message, add emoji, share a GIF, or drop a voice note."
                      value={draft}
                    />
                    <div className="flex flex-wrap gap-2">
                      {quickEmojis.map((emoji) => (
                        <button
                          key={emoji}
                          className="rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-lg"
                          onClick={() => addEmojiToComposer(emoji, "match")}
                          type="button"
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {stickerPack.map((sticker) => (
                        <button
                          key={sticker.label}
                          className="rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-sm"
                          onClick={() => sendMessage("sticker", sticker.content)}
                          type="button"
                        >
                          {sticker.content} {sticker.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <label className="inline-flex cursor-pointer items-center gap-2 rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-sm">
                        <ImagePlus className="h-4 w-4" />
                        Image
                        <input className="hidden" onChange={(event) => attachImage(event, "match")} type="file" />
                      </label>
                      <button
                        className="rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-sm"
                        onClick={() => toggleVoiceNote("match")}
                        type="button"
                      >
                        <Mic className="mr-2 inline h-4 w-4" />
                        {isRecording ? "Stop Voice Note" : "Voice Note"}
                      </button>
                      <input
                        className="flex-1 rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-sm placeholder:text-slate-500"
                        onChange={(event) => setGifUrl(event.target.value)}
                        placeholder="Paste GIF URL"
                        value={gifUrl}
                      />
                      <button
                        className="rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-sm"
                        onClick={() => sendMessage("gif", gifUrl)}
                        type="button"
                      >
                        Send GIF
                      </button>
                      <button
                        className="ml-auto inline-flex items-center gap-2 rounded-2xl bg-gradient-to-r from-electric to-violet px-4 py-2.5 text-sm font-medium text-white"
                        onClick={() => sendMessage("text")}
                        type="button"
                      >
                        <Send className="h-4 w-4" />
                        Send
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {activeTab === "rooms" && (
              <section className="grid gap-4 xl:grid-cols-[0.92fr_1.08fr]">
                <div className="space-y-4">
                  <div className="rounded-[32px] border border-slate-200/80 bg-white/80 p-5 backdrop-blur-xl">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Room Directory</p>
                        <h3 className="mt-1 text-xl font-semibold">Public, private, and region-aware rooms</h3>
                      </div>
                      <button
                        className="rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-sm"
                        onClick={reloadRooms}
                        type="button"
                      >
                        Refresh
                      </button>
                    </div>
                    <div className="mt-4 grid gap-3">
                      {rooms.map((room) => (
                        <button
                          key={room.id}
                          className="rounded-3xl border border-slate-200/80 bg-white/75 p-4 text-left transition hover:bg-white/80"
                          onClick={() => joinRoom(room)}
                          type="button"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className={cn(!isRegistered && "blur-sm")}>
                              <p className="font-medium text-slate-900">{room.name}</p>
                              <p className="mt-1 text-sm text-slate-500">{room.description}</p>
                            </div>
                            <div className="rounded-full border border-slate-200/80 px-3 py-1 text-xs text-slate-600">
                              {room.isPrivate ? "Private" : room.region}
                            </div>
                          </div>
                          <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
                            <span>{room.category}</span>
                            <span className="inline-flex items-center gap-1">
                              {room.isPrivate ? <Lock className="h-3.5 w-3.5" /> : <Users className="h-3.5 w-3.5" />}
                              {room.isPrivate ? "Request access" : "Join now"}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                    {!isRegistered && (
                      <div className="mt-4 rounded-3xl border border-amber-300/20 bg-amber-400/10 p-4 text-sm text-amber-100">
                        Register or log in to reveal room names, read messages clearly, and join private spaces.
                      </div>
                    )}
                  </div>

                  <div className="rounded-[32px] border border-slate-200/80 bg-white/80 p-5 backdrop-blur-xl">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Create Room</p>
                        <h3 className="mt-1 text-xl font-semibold">Launch a premium lounge</h3>
                      </div>
                      <DoorOpen className="h-5 w-5 text-aqua" />
                    </div>
                    <div className="mt-4 grid gap-3">
                      <input
                        className="rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm"
                        onChange={(event) =>
                          setNewRoom((current) => ({ ...current, name: event.target.value }))
                        }
                        placeholder="Room name"
                        value={newRoom.name}
                      />
                      <textarea
                        className="min-h-24 rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm"
                        onChange={(event) =>
                          setNewRoom((current) => ({ ...current, description: event.target.value }))
                        }
                        placeholder="Describe the room vibe"
                        value={newRoom.description}
                      />
                      <div className="grid gap-3 md:grid-cols-3">
                        <input
                          className="rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm"
                          onChange={(event) =>
                            setNewRoom((current) => ({ ...current, category: event.target.value }))
                          }
                          placeholder="Category"
                          value={newRoom.category}
                        />
                        <input
                          className="rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm"
                          onChange={(event) =>
                            setNewRoom((current) => ({ ...current, region: event.target.value }))
                          }
                          placeholder="Region"
                          value={newRoom.region}
                        />
                        <label className="flex items-center gap-3 rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm">
                          <input
                            checked={newRoom.isPrivate}
                            onChange={(event) =>
                              setNewRoom((current) => ({ ...current, isPrivate: event.target.checked }))
                            }
                            type="checkbox"
                          />
                          Private room
                        </label>
                      </div>
                      <button
                        className="inline-flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-electric to-violet px-4 py-3 text-sm font-medium text-white"
                        onClick={createRoom}
                        type="button"
                      >
                        <ChevronRight className="h-4 w-4" />
                        Create Room
                      </button>
                    </div>
                    <div className="mt-4 rounded-3xl border border-slate-200/80 bg-white/75 p-4">
                      <p className="text-sm font-medium text-slate-900">Request private room access</p>
                      <p className="mt-1 text-sm text-slate-500">
                        Private rooms stay hidden from the directory. Paste a room key to request entry.
                      </p>
                      <div className="mt-3 flex gap-2">
                        <input
                          className="flex-1 rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm"
                          onChange={(event) => setPrivateRoomKey(event.target.value)}
                          placeholder="Private room key"
                          value={privateRoomKey}
                        />
                        <button
                          className="rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm"
                          onClick={requestPrivateRoom}
                          type="button"
                        >
                          Request
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded-[32px] border border-slate-200/80 bg-white/80 p-5 backdrop-blur-xl">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Active Room</p>
                        <h3 className="mt-1 text-xl font-semibold">
                          {activeRoom?.name || "Join a room to open the feed"}
                        </h3>
                      </div>
                      {roomTyping && <p className="text-sm text-aqua">typing...</p>}
                    </div>

                    <div className="mt-4 h-[420px] overflow-y-auto rounded-[28px] border border-slate-200/80 bg-white/80 p-4">
                      <div className={cn("space-y-3", !isRegistered && "blur-sm")}>
                        {roomMessages.map((message) => (
                          <ChatBubble
                            key={message.id}
                            isBlurred={!isRegistered}
                            isOwn={message.senderId === socketId || message.senderId === "me"}
                            message={message}
                          />
                        ))}
                      </div>
                      {!isRegistered && (
                        <div className="sticky bottom-2 mx-auto mt-4 max-w-md rounded-3xl border border-slate-200/80 bg-white/95 px-4 py-3 text-center text-sm text-slate-900 backdrop-blur-xl">
                          Register or login to reveal messages and join private rooms.
                        </div>
                      )}
                    </div>

                    <div className="mt-4 space-y-3">
                      {composerActionError ? (
                        <p className="text-sm text-rose-600">{composerActionError}</p>
                      ) : null}
                      {activeRoom?.isPrivate && (
                        <div className="rounded-3xl border border-electric/20 bg-electric/10 p-4 text-sm text-slate-200">
                          Private room key: <span className="font-semibold text-slate-900">{activeRoom.id}</span>
                        </div>
                      )}
                      <textarea
                        className="min-h-24 w-full rounded-3xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm"
                        onChange={(event) => {
                          setRoomDraft(event.target.value);
                          if (activeRoom) {
                            onRoomTyping();
                          }
                        }}
                        onKeyDown={(event) => handleComposerEnter(event, () => sendRoomMessage("text"))}
                        placeholder="Message the room, add emoji, or send a sticker..."
                        value={roomDraft}
                      />
                      <div className="flex flex-wrap gap-2">
                        {quickEmojis.map((emoji) => (
                          <button
                            key={emoji}
                            className="rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-lg"
                            onClick={() => addEmojiToComposer(emoji, "room")}
                            type="button"
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {stickerPack.map((sticker) => (
                          <button
                            key={sticker.label}
                            className="rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-sm"
                            onClick={() => sendRoomMessage("sticker", sticker.content)}
                            type="button"
                          >
                            {sticker.content} {sticker.label}
                          </button>
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <label className="inline-flex cursor-pointer items-center gap-2 rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-sm">
                          <ImagePlus className="h-4 w-4" />
                          Image
                          <input className="hidden" onChange={(event) => attachImage(event, "room")} type="file" />
                        </label>
                        <button
                          className="rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-sm"
                          onClick={() => toggleVoiceNote("room")}
                          type="button"
                        >
                          <Mic className="mr-2 inline h-4 w-4" />
                          {isRecording ? "Stop Voice Note" : "Voice Note"}
                        </button>
                        <input
                          className="flex-1 rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-sm"
                          onChange={(event) => setRoomGifUrl(event.target.value)}
                          placeholder="Paste GIF URL"
                          value={roomGifUrl}
                        />
                        <button
                          className="rounded-2xl border border-slate-200/80 bg-white/80 px-3 py-2 text-sm"
                          onClick={() => sendRoomMessage("gif", roomGifUrl)}
                          type="button"
                        >
                          Send GIF
                        </button>
                        <button
                          className="ml-auto inline-flex items-center gap-2 rounded-2xl bg-gradient-to-r from-electric to-violet px-4 py-2.5 text-sm font-medium text-white"
                          onClick={() => sendRoomMessage("text")}
                          type="button"
                        >
                          <Send className="h-4 w-4" />
                          Send
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-[32px] border border-slate-200/80 bg-white/80 p-5 backdrop-blur-xl">
                    <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Private Room Requests</p>
                    <div className="mt-4 space-y-3">
                      {pendingRequests.length === 0 && (
                        <div className="rounded-3xl border border-slate-200/80 bg-white/75 p-4 text-sm text-slate-500">
                          No join requests waiting right now.
                        </div>
                      )}
                      {pendingRequests.map((request) => (
                        <div
                          key={`${request.roomId}-${request.requesterId}`}
                          className="rounded-3xl border border-slate-200/80 bg-white/75 p-4"
                        >
                          <p className="font-medium text-slate-900">
                            {request.requesterProfile?.nickname || "Someone"} wants to join{" "}
                            {request.roomName}
                          </p>
                          <div className="mt-3 flex gap-2">
                            <button
                              className="rounded-2xl bg-aqua/20 px-4 py-2 text-sm text-aqua"
                              onClick={() => resolveAccessRequest(request, "admit")}
                              type="button"
                            >
                              Admit
                            </button>
                            <button
                              className="rounded-2xl bg-rose-500/20 px-4 py-2 text-sm text-rose-200"
                              onClick={() => resolveAccessRequest(request, "decline")}
                              type="button"
                            >
                              Decline
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            )}

            {activeTab === "ai" && (
              <section className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
                <div className="space-y-4 rounded-[32px] border border-slate-200/80 bg-white/80 p-5 backdrop-blur-xl">
                  <div>
                    <p className="text-xs uppercase tracking-[0.32em] text-slate-500">AI Personas</p>
                    <h3 className="mt-1 text-xl font-semibold">Dedicated assistant channels</h3>
                  </div>
                  {aiPersonas.map((persona) => (
                    <button
                      key={persona.id}
                      className={cn(
                        "w-full rounded-3xl border p-4 text-left transition",
                        aiPersonaId === persona.id
                          ? "border-electric/40 bg-white/90"
                          : "border-slate-200/80 bg-white/75",
                      )}
                      onClick={() => openAiChannel(persona.id)}
                      type="button"
                    >
                      <div
                        className={cn(
                          "mb-3 inline-flex rounded-2xl bg-gradient-to-r px-3 py-1 text-xs text-white",
                          persona.accent,
                        )}
                      >
                        {persona.name}
                      </div>
                      <p className="text-sm text-slate-600">{persona.description}</p>
                    </button>
                  ))}
                </div>

                <div className="rounded-[32px] border border-slate-200/80 bg-white/80 p-5 backdrop-blur-xl">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs uppercase tracking-[0.32em] text-slate-500">AI Conversation</p>
                      <h3 className="mt-1 text-xl font-semibold">
                        {aiPersonas.find((persona) => persona.id === aiPersonaId)?.name}
                      </h3>
                    </div>
                    <Sparkles className="h-5 w-5 text-aqua" />
                  </div>
                  <div className="mt-4 h-[420px] space-y-3 overflow-y-auto rounded-[28px] border border-slate-200/80 bg-white/80 p-4">
                    {aiMessages.map((message) => (
                      <ChatBubble
                        key={message.id}
                        isBlurred={false}
                        isOwn={message.senderId === "me"}
                        message={message}
                      />
                    ))}
                  </div>
                  <div className="mt-4 flex gap-3">
                    <textarea
                      className="min-h-24 flex-1 rounded-3xl border border-slate-200/80 bg-white/80 px-4 py-3 text-sm"
                      onChange={(event) => setAiDraft(event.target.value)}
                      onKeyDown={(event) => handleComposerEnter(event, sendAiPrompt)}
                      placeholder="Ask for advice, jokes, or a roleplay setup."
                      value={aiDraft}
                    />
                    <button
                      className="inline-flex items-center justify-center gap-2 rounded-3xl bg-gradient-to-r from-electric to-violet px-5 py-4 text-sm font-medium text-white"
                      onClick={sendAiPrompt}
                      type="button"
                      disabled={isAiLoading}
                    >
                      <Send className="h-4 w-4" />
                      {isAiLoading ? "Thinking..." : "Send"}
                    </button>
                  </div>
                </div>
              </section>
            )}
          </main>

          <aside className="space-y-4">
            <div className="rounded-[32px] border border-slate-200/80 bg-white/80 p-5 backdrop-blur-xl">
              <p className="text-xs uppercase tracking-[0.32em] text-slate-500">Realtime Signals</p>
              <div className="mt-4 space-y-3">
                <div className="rounded-3xl border border-slate-200/80 bg-white/75 p-4">
                  <p className="text-sm text-slate-500">Socket session</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">{socketId || "Awaiting connection"}</p>
                </div>
                <div className="rounded-3xl border border-slate-200/80 bg-white/75 p-4">
                  <p className="text-sm text-slate-500">Search area</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">{onboarding.country}</p>
                </div>
                <div className="rounded-3xl border border-slate-200/80 bg-white/75 p-4">
                  <p className="text-sm text-slate-500">Access state</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">
                    {isRegistered ? "Registered" : "Guest Preview"}
                  </p>
                </div>
              </div>
            </div>

            <AdSensePlaceholder label="Contextual ad unit between room list cards." />
          </aside>
        </div>
      </div>
    </div>
  );
}
