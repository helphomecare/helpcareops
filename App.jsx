import React, { useEffect, useMemo, useState } from "react";
import {
  ShieldAlert, Users, HardHat, Calendar, Clock, CreditCard,
  MapPin, Activity, Settings, Megaphone, DollarSign, Plus,
  Trash2, X, Edit3, ClipboardCheck, Thermometer, Share2, Home,
  UserPlus, UserX, LogOut
} from "lucide-react";

import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  onSnapshot,
  updateDoc,
  serverTimestamp,
  Timestamp
} from "firebase/firestore";

import {
  getAuth,
  onAuthStateChanged,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut
} from "firebase/auth";

/** ------------------------------------------
 * Firebase config:
 * - In ChatGPT artifact env, __firebase_config exists
 * - In your real deployment, use env vars
 * ------------------------------------------ */
const firebaseConfig =
  typeof __firebase_config !== "undefined"
    ? JSON.parse(__firebase_config)
    : {
        apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
        authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
        projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID
      };

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/** Org scoping (multi-tenant friendly). Change this to your real org id. */
const ORG_ID =
  typeof __app_id !== "undefined" && __app_id ? __app_id : "help-homecare-prod";

/** Firestore helpers */
const colRef = (name) => collection(db, "orgs", ORG_ID, name);
const docRef = (name, id) => doc(db, "orgs", ORG_ID, name, id);

/** Field rendering */
const fieldLabel = (k) => k.replaceAll("_", " ");

function stripMeta(obj = {}) {
  // Remove local-only or firestore metadata
  const { id, createdAt, updatedAt, createdBy, updatedBy, ...rest } = obj;
  return rest;
}

function isTruthy(v) {
  return v !== null && v !== undefined && v !== "";
}

export default function App() {
  const [authUser, setAuthUser] = useState(null);
  const [profile, setProfile] = useState(null);

  const [activeTab, setActiveTab] = useState("dashboard");
  const [dbData, setDbData] = useState({});

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [formData, setFormData] = useState({});

  // Login UI
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [authErr, setAuthErr] = useState("");

  // Broadcast
  const [broadcastMsg, setBroadcastMsg] = useState("");

  // Call-off
  const [isCallOffOpen, setIsCallOffOpen] = useState(false);
  const [callOffStaff, setCallOffStaff] = useState(null);
  const [absenceReason, setAbsenceReason] = useState("");
  const [absenceNote, setAbsenceNote] = useState("");

  // --- MODULE CONFIG (consistent fields) ---
  const modules = useMemo(() => ([
    { id: "dashboard", label: "COMMAND CENTER", icon: ShieldAlert, group: "SYSTEM", fields: [] },

    // CLINICAL (If you keep diagnosis/vitals, treat as PHI)
    {
      id: "clients",
      label: "CLIENT CENSUS",
      icon: Users,
      group: "CLINICAL",
      fields: ["Name", "Medicaid_ID", "Care_Level", "Diagnosis", "Auth_Units_Total", "Auth_Units_Remaining", "Status"]
    },
    {
      id: "assessments",
      label: "NURSE ASSESSMENTS",
      icon: ClipboardCheck,
      group: "CLINICAL",
      fields: ["Client", "Nurse", "Assessment_Type", "Risk_Score", "Notes", "Status"]
    },
    {
      id: "care_plans",
      label: "CARE PLANS",
      icon: ClipboardCheck,
      group: "CLINICAL",
      fields: ["Client", "Primary_Goal", "Interventions", "Review_Date", "Status"]
    },
    { id: "vitals", label: "VITALS LOG", icon: Thermometer, group: "CLINICAL", fields: ["Client", "BP", "HR", "Temp", "O2", "Notes"] },
    { id: "referral_portal", label: "REFERRALS", icon: Share2, group: "CLINICAL", fields: ["Referrer", "Patient", "Insurance", "Status", "Notes"] },

    // HR
    { id: "staff", label: "CAREGIVER FLEET", icon: HardHat, group: "HR", fields: ["Name", "Role", "Phone", "License_Exp", "Status"] },
    { id: "attendance", label: "ATTENDANCE", icon: UserX, group: "HR", fields: ["Staff", "Type", "Reason", "Note", "Date"] },
    { id: "training", label: "LMS ACADEMY", icon: UserPlus, group: "HR", fields: ["Staff", "Course", "Completion", "Expiry"] },
    { id: "applicants", label: "HIRING PIPELINE", icon: UserPlus, group: "HR", fields: ["Name", "Role", "Stage", "Interview_Date"] },

    // LOGISTICS
    { id: "evv", label: "EVV TRACKING", icon: MapPin, group: "LOGISTICS", fields: ["Visit_ID", "Staff", "Client", "GPS_Coords", "Status"] },
    { id: "scheduling", label: "MASTER MATRIX", icon: Calendar, group: "LOGISTICS", fields: ["Client", "Staff", "Shift_Day", "Time_Slot", "Notes"] },
    { id: "timeclock", label: "TIMECLOCK", icon: Clock, group: "LOGISTICS", fields: ["Staff", "Action", "Location", "Time"] },

    // FINANCE
    { id: "billing", label: "REVENUE CYCLE", icon: DollarSign, group: "FINANCE", fields: ["Claim_ID", "Payer", "Amount", "Status", "Service_Date", "Notes"] },
    { id: "payroll", label: "PAYROLL", icon: CreditCard, group: "FINANCE", fields: ["Staff", "Hours_Reg", "Hours_OT", "Total_Pay", "Status"] },

    // SYSTEM
    { id: "family_portal", label: "FAMILY PORTAL", icon: Home, group: "PORTALS", fields: ["Family_User", "Client_Link", "Access_Level", "Status"] },
    { id: "broadcast", label: "ALERTS", icon: Megaphone, group: "SYSTEM", fields: ["Message", "Audience", "Severity"] },
    { id: "settings", label: "CONFIG", icon: Settings, group: "SYSTEM", fields: ["Setting", "Value"] }
  ]), []);

  const currentModule = modules.find((m) => m.id === activeTab) || modules[0];

  // ---- RBAC (UI side). Real enforcement is in Firestore rules. ----
  const role = profile?.role || "pending";
  const isActive = !!profile?.isActive;
  const isAdmin = role === "admin" || role === "director";
  const isFinance = isAdmin || role === "finance";

  const canSeeModule = (m) => {
    if (m.group === "FINANCE") return isFinance;
    return true;
  };

  const canWriteModule = (tabId) => {
    if (!isActive) return false;
    if (isAdmin) return true;
    return ["evv", "timeclock", "attendance"].includes(tabId);
  };

  // --- AUTH BOOT ---
  useEffect(() => {
    const init = async () => {
      // If running in the ChatGPT artifact sandbox with a token, sign in
      if (typeof __initial_auth_token !== "undefined" && __initial_auth_token) {
        await signInWithCustomToken(auth, __initial_auth_token);
      }
      // Otherwise: DO NOT auto-anon sign-in for a staff app
    };
    init().catch(console.error);

    const unsub = onAuthStateChanged(auth, (u) => setAuthUser(u));
    return () => unsub();
  }, []);

  // --- Ensure user profile doc exists, and watch it ---
  useEffect(() => {
    if (!authUser) return;

    const uref = doc(db, "orgs", ORG_ID, "users", authUser.uid);

    (async () => {
      const snap = await getDoc(uref);
      if (!snap.exists()) {
        await setDoc(
          uref,
          {
            email: authUser.email || null,
            displayName: authUser.displayName || "",
            role: "pending",
            isActive: false,
            createdAt: serverTimestamp()
          },
          { merge: true }
        );
      }
    })().catch(console.error);

    return onSnapshot(
      uref,
      (s) => setProfile(s.exists() ? { id: s.id, ...s.data() } : null),
      console.error
    );
  }, [authUser]);

  // --- DATA SUBSCRIPTIONS (only what we need + active tab) ---
  const watchCollections = useMemo(() => {
    const core = ["clients", "staff", "evv", "broadcast", "attendance", "scheduling"];
    return Array.from(new Set([...core, activeTab])).filter(Boolean);
  }, [activeTab]);

  useEffect(() => {
    if (!authUser || !isActive) return;

    const unsubs = watchCollections.map((name) =>
      onSnapshot(
        colRef(name),
        (snap) => {
          const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
          setDbData((prev) => ({ ...prev, [name]: rows }));
        },
        console.error
      )
    );

    return () => unsubs.forEach((u) => u && u());
  }, [authUser, isActive, watchCollections]);

  // --- AUTH ACTIONS ---
  const doLogin = async () => {
    setAuthErr("");
    try {
      await signInWithEmailAndPassword(auth, email.trim(), pass);
    } catch (e) {
      setAuthErr(e?.message || "Login failed.");
    }
  };

  const doRegister = async () => {
    setAuthErr("");
    try {
      await createUserWithEmailAndPassword(auth, email.trim(), pass);
      // profile will be created as pending/inactive; admin must activate
    } catch (e) {
      setAuthErr(e?.message || "Registration failed.");
    }
  };

  const doLogout = async () => {
    await signOut(auth);
    setProfile(null);
    setDbData({});
    setActiveTab("dashboard");
  };

  // --- ACTIONS ---
  const sendBroadcast = async () => {
    if (!broadcastMsg.trim()) return;
    if (!canWriteModule("broadcast")) return alert("Not authorized.");

    await addDoc(colRef("broadcast"), {
      Message: broadcastMsg.trim(),
      Audience: "All Field Staff",
      Severity: "High",
      createdAt: serverTimestamp(),
      createdBy: authUser.uid
    });

    setBroadcastMsg("");
  };

  const handleCallOff = async (staffId, staffName) => {
    if (!absenceReason) return alert("Please select a reason.");
    if (!canWriteModule("attendance")) return alert("Not authorized.");

    await addDoc(colRef("attendance"), {
      Staff: staffName,
      Type: "Call-Off",
      Reason: absenceReason,
      Note: absenceNote || "",
      Date: new Date().toISOString().slice(0, 10),
      createdAt: serverTimestamp(),
      createdBy: authUser.uid
    });

    if (staffId && isAdmin) {
      await updateDoc(docRef("staff", staffId), { Status: "Absent", updatedAt: serverTimestamp(), updatedBy: authUser.uid });
    }

    setIsCallOffOpen(false);
    setCallOffStaff(null);
    setAbsenceReason("");
    setAbsenceNote("");
  };

  const dischargeClient = async (clientId) => {
    if (!isAdmin) return alert("Only admin/director can discharge.");
    await updateDoc(docRef("clients", clientId), {
      Status: "Discharged",
      DischargedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      updatedBy: authUser.uid
    });
  };

  const archiveRecord = async (tab, id) => {
    if (!isAdmin) return alert("Only admin/director can archive.");
    await updateDoc(docRef(tab, id), {
      Status: "Archived",
      archivedAt: serverTimestamp(),
      archivedBy: authUser.uid
    });
  };

  const completeVisit = async (visit) => {
    if (!canWriteModule("evv")) return alert("Not authorized.");

    const endTs = Timestamp.now();
    const endMs = endTs.toMillis();
    const startMs = visit.Time_In?.toMillis ? visit.Time_In.toMillis() : (endMs - 3600000);

    const durationMinutes = Math.max(0, (endMs - startMs) / (1000 * 60));
    const unitsUsed = Math.ceil(durationMinutes / 15);

    await updateDoc(docRef("evv", visit.id), {
      Time_Out: endTs,
      Duration_Minutes: Math.round(durationMinutes),
      Units_Billed: unitsUsed,
      GPS_Status: "Verified",
      Status: "Completed",
      updatedAt: serverTimestamp(),
      updatedBy: authUser.uid
    });

    // Deduct from client unit bank
    const client = (dbData.clients || []).find((c) => c.Name === visit.Client);
    if (client?.id) {
      const starting = parseInt(client.Auth_Units_Remaining ?? client.Auth_Units_Total ?? 0, 10) || 0;
      const newRemaining = Math.max(0, starting - unitsUsed);

      await updateDoc(docRef("clients", client.id), {
        Auth_Units_Remaining: newRemaining,
        updatedAt: serverTimestamp(),
        updatedBy: authUser.uid
      });
    }
  };

  const saveRecord = async (e) => {
    e.preventDefault();
    if (!canWriteModule(activeTab)) return alert("Not authorized.");

    const payload = stripMeta(formData);
    const now = serverTimestamp();

    if (editingId) {
      await updateDoc(docRef(activeTab, editingId), {
        ...payload,
        updatedAt: now,
        updatedBy: authUser.uid
      });
    } else {
      await addDoc(colRef(activeTab), {
        ...payload,
        Status: payload.Status || "Active",
        createdAt: now,
        createdBy: authUser.uid
      });
    }

    setIsModalOpen(false);
    setEditingId(null);
    setFormData({});
  };

  // ---- VIEWS ----
  const DashboardView = () => {
    const clients = dbData.clients || [];
    const staff = dbData.staff || [];
    const evv = dbData.evv || [];

    const activeCensus = clients.filter((c) => (c.Status || "Active") !== "Discharged" && (c.Status || "") !== "Archived").length;
    const onShift = evv.filter((v) => v.Status !== "Completed").length;
    const unbilledUnits = evv
      .filter((v) => v.Status === "Completed" && !v.Billed)
      .reduce((sum, v) => sum + (parseInt(v.Units_Billed, 10) || 0), 0);

    return (
      <div className="space-y-8 animate-in fade-in duration-500">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          {[
            { label: "ACTIVE CENSUS", value: activeCensus, icon: Users, color: "text-orange-600", border: "border-orange-500" },
            { label: "STAFF ON-SHIFT", value: onShift, icon: HardHat, color: "text-green-600", border: "border-green-500" },
            { label: "UNBILLED UNITS", value: unbilledUnits, icon: Activity, color: "text-yellow-600", border: "border-yellow-400" },
            { label: "STAFF TOTAL", value: staff.length, icon: HardHat, color: "text-black", border: "border-black" }
          ].map((s, i) => (
            <div key={i} className={`bg-white p-8 rounded-[2.5rem] shadow-xl border-b-8 ${s.border}`}>
              <s.icon size={32} className={`${s.color} mb-4`} />
              <h3 className="text-4xl font-black text-black italic tracking-tighter">{s.value}</h3>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-2">{s.label}</p>
            </div>
          ))}
        </div>

        <div className="bg-white rounded-[3rem] p-10 border-4 border-slate-50 shadow-xl">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-2xl font-black text-black italic uppercase flex items-center gap-3">
              <Megaphone className="text-orange-500" /> LIVE BROADCAST
            </h3>
            <span className="bg-red-500 text-white px-3 py-1 rounded-full text-[9px] font-black uppercase animate-pulse">System Live</span>
          </div>

          <div className="flex gap-4 mb-8">
            <input
              value={broadcastMsg}
              onChange={(e) => setBroadcastMsg(e.target.value)}
              placeholder={canWriteModule("broadcast") ? "TYPE ALERT MESSAGE TO FIELD STAFF..." : "Only admin can broadcast."}
              disabled={!canWriteModule("broadcast")}
              className="flex-1 bg-slate-50 border-2 border-slate-100 rounded-2xl px-6 py-4 font-bold text-sm outline-none focus:border-orange-500 transition-all uppercase disabled:opacity-50"
            />
            <button
              onClick={sendBroadcast}
              disabled={!canWriteModule("broadcast")}
              className="bg-black text-white px-8 py-4 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-orange-600 transition-colors shadow-lg disabled:opacity-50"
            >
              DISPATCH
            </button>
          </div>
        </div>
      </div>
    );
  };

  const AttendanceView = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center bg-white p-8 rounded-[2rem] border-l-8 border-orange-600 shadow-sm">
        <h2 className="text-3xl font-black text-black uppercase italic tracking-tighter">ATTENDANCE</h2>
        <button
          onClick={() => { setCallOffStaff(null); setIsCallOffOpen(true); }}
          className="bg-black text-white px-6 py-3 rounded-xl font-black text-xs uppercase hover:bg-orange-600"
        >
          Log Call-Off
        </button>
      </div>

      <div className="bg-white rounded-[2rem] p-6 shadow-sm">
        <h3 className="font-black uppercase text-sm text-slate-500 mb-4">Staff Roster</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(dbData.staff || []).map((s) => (
            <div key={s.id} className="p-4 rounded-2xl border border-slate-100 flex items-center justify-between">
              <div>
                <div className="font-black uppercase text-sm">{s.Name}</div>
                <div className="text-[10px] font-bold uppercase text-slate-400">{s.Role || "Staff"} • {s.Status || "Active"}</div>
              </div>
              <button
                onClick={() => { setCallOffStaff(s); setIsCallOffOpen(true); }}
                className="bg-orange-600 text-white px-4 py-2 rounded-xl font-black text-[10px] uppercase hover:bg-orange-700"
              >
                Call-Off
              </button>
            </div>
          ))}
          {(dbData.staff || []).length === 0 && (
            <div className="col-span-full text-center py-10 text-slate-300 font-black italic uppercase">
              No staff records yet.
            </div>
          )}
        </div>
      </div>

      <div className="bg-white rounded-[2rem] p-6 shadow-sm">
        <h3 className="font-black uppercase text-sm text-slate-500 mb-4">Recent Log</h3>
        <div className="space-y-3">
          {(dbData.attendance || [])
            .slice()
            .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
            .slice(0, 20)
            .map((a) => (
              <div key={a.id} className="p-4 rounded-2xl bg-slate-50 border border-slate-100">
                <div className="flex justify-between">
                  <div className="font-black uppercase text-xs">{a.Staff}</div>
                  <div className="text-[10px] font-black uppercase text-slate-400">{a.Date || ""}</div>
                </div>
                <div className="text-[10px] font-bold uppercase text-slate-500 mt-1">
                  {a.Type} • {a.Reason} {a.Note ? `• ${a.Note}` : ""}
                </div>
              </div>
            ))}
          {(dbData.attendance || []).length === 0 && (
            <div className="text-center py-10 text-slate-300 font-black italic uppercase">
              No attendance records.
            </div>
          )}
        </div>
      </div>

      {isCallOffOpen && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-sm z-[120] flex items-center justify-center p-6">
          <div className="bg-white w-full max-w-lg rounded-[3rem] border-[10px] border-orange-600 overflow-hidden shadow-2xl">
            <div className="p-8 bg-black text-white flex justify-between items-center">
              <h3 className="text-2xl font-black italic uppercase">
                Log Call-Off {callOffStaff?.Name ? `• ${callOffStaff.Name}` : ""}
              </h3>
              <button onClick={() => setIsCallOffOpen(false)}><X /></button>
            </div>

            <div className="p-8 space-y-6">
              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Reason</label>
                <select
                  value={absenceReason}
                  onChange={(e) => setAbsenceReason(e.target.value)}
                  className="w-full p-4 bg-slate-100 rounded-xl font-bold text-xs outline-none focus:ring-2 ring-orange-500"
                >
                  <option value="">Select…</option>
                  <option value="Sick">Sick</option>
                  <option value="Family Emergency">Family Emergency</option>
                  <option value="Car Trouble">Car Trouble</option>
                  <option value="No Show">No Show</option>
                  <option value="Other">Other</option>
                </select>
              </div>

              <div>
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Note</label>
                <input
                  value={absenceNote}
                  onChange={(e) => setAbsenceNote(e.target.value)}
                  className="w-full p-4 bg-slate-100 rounded-xl font-bold text-xs outline-none focus:ring-2 ring-orange-500"
                  placeholder="Optional details…"
                />
              </div>

              <button
                onClick={() => handleCallOff(callOffStaff?.id, callOffStaff?.Name || "Unknown")}
                className="w-full py-4 bg-green-500 text-white font-black uppercase rounded-xl hover:bg-green-600 shadow-xl"
              >
                Save Call-Off
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const ClinicalView = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center bg-white p-8 rounded-[2rem] border-l-8 border-green-500 shadow-sm">
        <h2 className="text-3xl font-black text-black uppercase italic tracking-tighter">{currentModule.label}</h2>
        <button
          onClick={() => { setEditingId(null); setFormData({}); setIsModalOpen(true); }}
          disabled={!canWriteModule(activeTab)}
          className="bg-green-500 text-white px-8 py-4 rounded-xl font-black text-xs uppercase hover:bg-green-600 transition-colors flex items-center gap-2 disabled:opacity-50"
        >
          <Plus size={16} /> New Record
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {(dbData[activeTab] || []).map((item) => (
          <div key={item.id} className="bg-white rounded-3xl p-6 shadow-lg border-t-4 border-green-500 flex flex-col gap-4">
            <div className="flex justify-between items-start">
              <div className="w-12 h-12 bg-green-50 rounded-xl flex items-center justify-center text-green-600 font-black text-lg">
                {(item.Name || item.Client || "X")?.[0]}
              </div>
              <span className="bg-slate-100 px-3 py-1 rounded-full text-[9px] font-black text-slate-500 uppercase">
                {item.Status || "Active"}
              </span>
            </div>

            <div>
              <h3 className="font-black text-lg uppercase text-black">{item.Name || item.Client}</h3>
              {"Medicaid_ID" in item && (
                <p className="text-xs font-bold text-slate-400 uppercase mt-1">ID: {item.Medicaid_ID || "---"}</p>
              )}
            </div>

            <div className="bg-slate-50 p-4 rounded-2xl">
              {currentModule.fields.filter((f) => !["Name", "Client", "Medicaid_ID"].includes(f)).slice(0, 4).map((f) => (
                <div key={f} className="flex justify-between text-[10px] uppercase mb-1">
                  <span className="font-bold text-slate-400">{fieldLabel(f)}</span>
                  <span className="font-black text-slate-800">{isTruthy(item[f]) ? String(item[f]) : "-"}</span>
                </div>
              ))}
            </div>

            <div className="flex gap-2 mt-auto">
              {activeTab === "clients" ? (
                <button
                  onClick={() => dischargeClient(item.id)}
                  className="flex-1 bg-red-50 text-red-500 py-2 rounded-xl font-black text-[10px] hover:bg-red-500 hover:text-white transition-colors"
                >
                  DISCHARGE
                </button>
              ) : (
                <button
                  onClick={() => archiveRecord(activeTab, item.id)}
                  className="flex-1 bg-red-50 text-red-500 py-2 rounded-xl font-black text-[10px] hover:bg-red-500 hover:text-white transition-colors"
                >
                  ARCHIVE
                </button>
              )}

              <button
                onClick={() => { setEditingId(item.id); setFormData(stripMeta(item)); setIsModalOpen(true); }}
                className="flex-1 bg-black text-white py-2 rounded-xl font-black text-[10px] hover:bg-green-500 transition-colors"
              >
                EDIT
              </button>
            </div>
          </div>
        ))}
        {(dbData[activeTab] || []).length === 0 && (
          <div className="col-span-full py-20 text-center text-slate-300 font-black italic uppercase text-xl">
            No Records Found
          </div>
        )}
      </div>
    </div>
  );

  const HRView = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center bg-white p-8 rounded-[2rem] border-l-8 border-orange-600 shadow-sm">
        <h2 className="text-3xl font-black text-black uppercase italic tracking-tighter">{currentModule.label}</h2>
        <button
          onClick={() => { setEditingId(null); setFormData({}); setIsModalOpen(true); }}
          disabled={!canWriteModule(activeTab)}
          className="bg-orange-600 text-white px-8 py-4 rounded-xl font-black text-xs uppercase hover:bg-orange-700 transition-colors flex items-center gap-2 disabled:opacity-50"
        >
          <Plus size={16} /> Add
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {(dbData[activeTab] || []).map((s) => (
          <div key={s.id} className="bg-white p-6 rounded-3xl border border-slate-100 shadow-lg flex items-center gap-4 hover:border-orange-500 transition-all">
            <div className="w-16 h-16 bg-orange-100 rounded-full flex items-center justify-center font-black text-orange-600 text-2xl">
              {(s.Name || "X")?.[0]}
            </div>
            <div className="flex-1">
              <h4 className="font-black uppercase text-black text-sm">{s.Name}</h4>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{s.Role || "Staff"}</p>
              <div className="flex gap-2 mt-2">
                <span className="text-[9px] bg-slate-100 px-2 py-0.5 rounded font-bold uppercase text-slate-500">{s.Phone || "-"}</span>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => { setEditingId(s.id); setFormData(stripMeta(s)); setIsModalOpen(true); }}
                className="p-2 bg-slate-50 rounded-lg hover:bg-black hover:text-white"
              >
                <Edit3 size={14} />
              </button>
              <button
                onClick={() => archiveRecord(activeTab, s.id)}
                className="p-2 bg-red-50 text-red-500 rounded-lg hover:bg-red-500 hover:text-white"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const FinanceView = () => (
    <div className="bg-white rounded-[3rem] shadow-xl border border-slate-200 overflow-hidden">
      <div className="p-8 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
        <h3 className="text-2xl font-black text-black uppercase flex items-center gap-3">
          <DollarSign className="text-green-600" /> {currentModule.label}
        </h3>
        <button
          onClick={() => { setEditingId(null); setFormData({}); setIsModalOpen(true); }}
          disabled={!canWriteModule(activeTab)}
          className="bg-black text-white px-6 py-3 rounded-xl font-black text-xs uppercase hover:bg-green-600 disabled:opacity-50"
        >
          New
        </button>
      </div>

      <table className="w-full text-left">
        <thead className="bg-black text-white text-[10px] font-black uppercase tracking-widest">
          <tr>
            {currentModule.fields.map((f) => <th key={f} className="p-6">{fieldLabel(f)}</th>)}
            <th className="p-6 text-right">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 font-mono text-xs uppercase font-bold text-slate-700">
          {(dbData[activeTab] || []).map((row) => (
            <tr key={row.id} className="hover:bg-green-50 transition-colors">
              {currentModule.fields.map((f) => (
                <td key={f} className="p-6">
                  {f === "Amount"
                    ? <span className="text-green-600 bg-green-100 px-2 py-1 rounded">${row[f] || 0}</span>
                    : (row[f] || "-")}
                </td>
              ))}
              <td className="p-6 text-right">
                <button onClick={() => archiveRecord(activeTab, row.id)}>
                  <Trash2 size={16} className="text-slate-300 hover:text-red-500" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const LogisticsView = () => {
    if (activeTab === "evv") {
      const activeVisits = (dbData.evv || []).filter((v) => v.Status !== "Completed");
      return (
        <div className="space-y-6">
          <div className="flex justify-between items-center bg-black p-8 rounded-[3rem] shadow-xl text-white">
            <div>
              <h2 className="text-3xl font-black italic uppercase tracking-tighter">EVV Monitor</h2>
              <p className="text-orange-500 font-bold text-xs uppercase tracking-[0.3em] mt-2">Unit Bank & Verification</p>
            </div>
            <button
              onClick={() => { setEditingId(null); setFormData({}); setIsModalOpen(true); }}
              disabled={!canWriteModule("evv")}
              className="bg-orange-600 text-white px-6 py-3 rounded-xl font-black text-xs uppercase hover:bg-green-600 disabled:opacity-50"
            >
              Add Visit
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="bg-white rounded-[2.5rem] p-8 border-4 border-slate-50 shadow-xl">
              <h3 className="font-black text-black text-xl uppercase mb-6 flex items-center gap-2">
                <MapPin size={20} className="text-orange-500" /> Active Visits
              </h3>

              <div className="space-y-4">
                {activeVisits.map((visit) => (
                  <div key={visit.id} className="p-6 bg-orange-50 rounded-2xl border-2 border-orange-100 flex justify-between items-center">
                    <div>
                      <p className="font-black text-orange-900 uppercase text-sm">{visit.Client || "-"}</p>
                      <p className="text-[10px] font-bold text-slate-500 uppercase mt-1">Staff: {visit.Staff || "-"}</p>
                    </div>
                    <button
                      onClick={() => completeVisit(visit)}
                      disabled={!canWriteModule("evv")}
                      className="bg-black text-white px-4 py-3 rounded-xl font-black text-[10px] uppercase hover:bg-green-600 transition-colors disabled:opacity-50"
                    >
                      Stop & Deduct
                    </button>
                  </div>
                ))}
                {activeVisits.length === 0 && (
                  <p className="text-center py-10 text-slate-300 font-black italic uppercase">No active visits.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Scheduling view
    const days = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
    const schedules = dbData.scheduling || [];

    return (
      <div className="bg-white rounded-[3rem] shadow-xl p-8 min-h-[600px]">
        <div className="flex justify-between items-center mb-8">
          <h2 className="text-3xl font-black text-black uppercase italic">{currentModule.label}</h2>
          <button
            onClick={() => { setIsModalOpen(true); setEditingId(null); setFormData({}); }}
            disabled={!canWriteModule("scheduling")}
            className="bg-orange-600 text-white px-6 py-3 rounded-xl font-black uppercase text-xs disabled:opacity-50"
          >
            Add Schedule
          </button>
        </div>

        <div className="grid grid-cols-7 gap-4">
          {days.map((d) => (
            <div key={d} className="bg-slate-50 rounded-xl p-4 min-h-[200px] border border-slate-100">
              <p className="text-center font-black text-slate-300 text-xs mb-4">{d}</p>
              <div className="space-y-2">
                {schedules
                  .filter((s) => (String(s.Shift_Day || "").toUpperCase().slice(0, 3) === d))
                  .map((s) => (
                    <div key={s.id} className="bg-white p-3 rounded-lg border-l-4 border-orange-500 shadow-sm">
                      <p className="text-[9px] font-black uppercase">{s.Client || "-"}</p>
                      <p className="text-[8px] font-bold text-slate-400">{s.Staff || "-"}</p>
                      <p className="text-[8px] font-bold text-slate-300">{s.Time_Slot || ""}</p>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // --- Login gate ---
  if (!authUser) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
        <div className="bg-white w-full max-w-md rounded-[2rem] shadow-xl border border-slate-200 overflow-hidden">
          <div className="p-8 bg-black text-white">
            <h1 className="text-2xl font-black uppercase italic">Help Homecare Ops</h1>
            <p className="text-xs font-bold text-slate-300 uppercase mt-2">Staff Login Required</p>
          </div>
          <div className="p-8 space-y-4">
            {authErr && <div className="bg-red-50 text-red-600 p-3 rounded-xl text-xs font-bold">{authErr}</div>}
            <input className="w-full p-4 bg-slate-100 rounded-xl font-bold text-xs outline-none"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input className="w-full p-4 bg-slate-100 rounded-xl font-bold text-xs outline-none"
              placeholder="Password"
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
            />
            <div className="flex gap-3">
              <button onClick={doLogin} className="flex-1 py-4 bg-green-500 text-white font-black uppercase rounded-xl hover:bg-green-600">
                Login
              </button>
              <button onClick={doRegister} className="flex-1 py-4 bg-black text-white font-black uppercase rounded-xl hover:bg-orange-600">
                Register
              </button>
            </div>
            <p className="text-[10px] text-slate-400 font-bold uppercase leading-relaxed">
              New users default to <span className="font-black">pending/inactive</span>. Admin must activate them in Firestore.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // --- Awaiting activation ---
  if (!isActive) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
        <div className="bg-white w-full max-w-lg rounded-[2rem] shadow-xl border border-slate-200 overflow-hidden">
          <div className="p-8 bg-black text-white flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-black uppercase italic">Account Pending</h1>
              <p className="text-xs font-bold text-slate-300 uppercase mt-2">
                Role: {role.toUpperCase()}
              </p>
            </div>
            <button onClick={doLogout} className="text-white flex items-center gap-2 font-black uppercase text-xs">
              <LogOut size={16} /> Logout
            </button>
          </div>
          <div className="p-8 space-y-3">
            <p className="font-bold text-slate-600">
              This account needs activation by an admin.
            </p>
            <p className="text-xs font-bold text-slate-400">
              In Firestore: <code>orgs/{ORG_ID}/users/{authUser.uid}</code> set <code>isActive: true</code> and assign a role.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Filter modules by visibility
  const visibleModules = modules.filter(canSeeModule);

  return (
    <div className="flex h-screen bg-slate-100 text-slate-900 font-sans overflow-hidden">
      {/* SIDEBAR */}
      <aside className="w-72 bg-orange-600 flex flex-col border-r-8 border-green-500 shadow-2xl overflow-y-auto shrink-0 z-50">
        <div className="p-8 bg-orange-700 sticky top-0 border-b-4 border-orange-800 z-10">
          <div className="flex items-center gap-3 justify-between">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-green-500 rounded-xl shadow-lg border-2 border-white">
                <ShieldAlert size={28} className="text-white" />
              </div>
              <div>
                <h1 className="font-black text-xl text-white tracking-tighter uppercase italic leading-none">
                  HELP HOMECARE
                </h1>
                <p className="text-[9px] text-orange-200 font-black tracking-widest mt-1">
                  OPS • ROLE: {role.toUpperCase()}
                </p>
              </div>
            </div>

            <button onClick={doLogout} className="text-white/90 hover:text-white">
              <LogOut size={18} />
            </button>
          </div>
        </div>

        <nav className="p-4 space-y-8">
          {[...new Set(visibleModules.map((m) => m.group))].map((group) => (
            <div key={group}>
              <h4 className="px-4 text-[10px] font-black text-black bg-white/20 inline-block py-1 rounded mb-3 uppercase tracking-widest">
                {group}
              </h4>
              <div className="space-y-1">
                {visibleModules
                  .filter((m) => m.group === group)
                  .map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setActiveTab(m.id)}
                      className={`w-full flex items-center gap-3 px-4 py-3 text-[11px] font-bold transition-all rounded-xl ${
                        activeTab === m.id
                          ? "bg-white text-orange-600 shadow-xl translate-x-1"
                          : "text-orange-100 hover:bg-orange-500"
                      }`}
                    >
                      <m.icon size={16} /> {m.label}
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      {/* MAIN */}
      <main className="flex-1 overflow-y-auto bg-slate-50 relative">
        <div className="p-10">
          {activeTab === "dashboard" ? <DashboardView /> :
            activeTab === "attendance" ? <AttendanceView /> :
            currentModule.group === "CLINICAL" ? <ClinicalView /> :
            currentModule.group === "HR" ? <HRView /> :
            currentModule.group === "FINANCE" ? <FinanceView /> :
            currentModule.group === "LOGISTICS" ? <LogisticsView /> :
            <div className="bg-white rounded-[3rem] p-10 shadow-xl text-center">
              <h2 className="text-3xl font-black uppercase italic">{currentModule.label}</h2>
              <p className="text-slate-400 font-bold uppercase mt-2 text-xs">Standard Operations Module</p>
              <button
                onClick={() => { setIsModalOpen(true); setEditingId(null); setFormData({}); }}
                disabled={!canWriteModule(activeTab)}
                className="mt-8 bg-black text-white px-8 py-4 rounded-2xl font-black uppercase text-xs disabled:opacity-50"
              >
                Add Record
              </button>
            </div>
          }
        </div>
      </main>

      {/* UNIVERSAL MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-sm z-[100] flex items-center justify-center p-6">
          <div className="bg-white w-full max-w-lg rounded-[3rem] border-[10px] border-orange-600 overflow-hidden shadow-2xl">
            <div className="p-8 bg-black text-white flex justify-between items-center">
              <h3 className="text-2xl font-black italic uppercase">{editingId ? "EDIT RECORD" : "NEW RECORD"}</h3>
              <button onClick={() => setIsModalOpen(false)}><X /></button>
            </div>

            <form onSubmit={saveRecord} className="p-8 space-y-6">
              {currentModule?.fields?.map((f) => (
                <div key={f}>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">
                    {fieldLabel(f)}
                  </label>

                  <input
                    value={formData[f] ?? ""}
                    onChange={(e) => setFormData({ ...formData, [f]: e.target.value })}
                    className="w-full p-4 bg-slate-100 rounded-xl font-bold uppercase text-xs outline-none focus:ring-2 ring-orange-500"
                  />
                </div>
              ))}

              <button
                type="submit"
                disabled={!canWriteModule(activeTab)}
                className="w-full py-4 bg-green-500 text-white font-black uppercase rounded-xl hover:bg-green-600 shadow-xl disabled:opacity-50"
              >
                Save
              </button>

              {!canWriteModule(activeTab) && (
                <p className="text-[10px] text-red-500 font-black uppercase">
                  You don’t have write permission for this module.
                </p>
              )}
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
