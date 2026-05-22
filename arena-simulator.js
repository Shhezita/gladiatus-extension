(() => {
    const root = typeof globalThis !== "undefined" ? globalThis : window;
    if (root.GladiatusArenaSimulator) return;

    function randInt(l, n) {
        return Math.floor(Math.random() * (n - l + 1)) + l;
    }

    function arena_simulator_calculate_chances(l, n) {
        const c = { ...l }, d = { ...n };
        c.avoid_critical_points = Math.max(0, c.avoid_critical_points);
        d.avoid_critical_points = Math.max(0, d.avoid_critical_points);
        c.block_points = Math.max(0, c.block_points);
        d.block_points = Math.max(0, d.block_points);
        c.critical_points = Math.max(0, c.critical_points);
        d.critical_points = Math.max(0, d.critical_points);

        const h = Math.max(2, c.level - 8);
        c.avoid_critical_chance = Math.round((52 * c.avoid_critical_points) / h / 4);
        c.avoid_critical_chance = Math.min(25, c.avoid_critical_chance);
        c.block_chance = Math.round((52 * c.block_points) / h / 6) + 2 * Math.max(0, c.level - d.level);
        c.block_chance = Math.min(50, c.block_chance);
        c.critical_chance = Math.round((52 * c.critical_points) / h / 5);
        c.critical_chance = Math.min(50, c.critical_chance);
        c.hit_chance = Math.floor((c.skill / (c.skill + d.agility)) * 100);
        c.double_hit_chance = Math.round(((c.charisma * c.skill) / (d.agility * d.intelligence)) * 10);

        if (c.buffs?.minerva || d.buffs?.minerva) c.double_hit_chance = 0;
        if (c.buffs?.mars || d.buffs?.mars) c.critical_chance = 0;
        if (c.buffs?.apollo) c.block_chance += 15;
        if (c.buffs?.honour_veteran) c.critical_chance += 10;
        if (d.buffs?.honour_destroyer) {
            c.armor -= 15 * d.level;
            if (c.armor < 0) c.armor = 0;
        }

        c.armor_absorve = [
            Math.floor(c.armor / 66) - Math.floor((c.armor - 66) / 660 + 1),
            Math.floor(c.armor / 66) + Math.floor(c.armor / 660),
        ];
        return c;
    }

    function arena_simulator_hit_simulation(l, n) {
        let c = 0;
        if (randInt(0, 100) <= (l.hit_chance || 0)) {
            if (randInt(0, 100) <= (l.critical_chance || 0)) {
                if (randInt(0, 100) <= (n.avoid_critical_chance || 0)) {
                    c = randInt(l.damage[0], l.damage[1]) - randInt(n.armor_absorve?.[0] ?? 0, n.armor_absorve?.[1] ?? 0);
                } else {
                    c = 2 * randInt(l.damage[0], l.damage[1]) - randInt(n.armor_absorve?.[0] ?? 0, n.armor_absorve?.[1] ?? 0);
                }
            } else {
                if (randInt(0, 100) <= (n.block_chance || 0)) {
                    c = Math.floor(randInt(l.damage[0], l.damage[1]) / 2) - randInt(n.armor_absorve?.[0] ?? 0, n.armor_absorve?.[1] ?? 0);
                } else {
                    c = randInt(l.damage[0], l.damage[1]) - randInt(n.armor_absorve?.[0] ?? 0, n.armor_absorve?.[1] ?? 0);
                }
            }
        }
        if (c < 0) c = 0;
        return c;
    }

    function arena_simulator_battle(l, n, c = "full", d = 15) {
        let h = c === "full" ? l.life[1] : l.life[0];
        let f = c === "full" ? n.life[1] : n.life[0];
        let p = 0, g = 0, m = 0;

        for (; m < d && h > 0 && f > 0; m++) {
            let b = arena_simulator_hit_simulation(l, n);
            p += b; f -= b;
            if (f <= 0) { p += f; break; }

            if (randInt(0, 100) <= (l.double_hit_chance || 0)) {
                b = arena_simulator_hit_simulation(l, n);
                p += b; f -= b;
                if (f <= 0) { p += f; break; }
            }

            b = arena_simulator_hit_simulation(n, l);
            g += b; h -= b;
            if (h <= 0) { g += h; break; }

            if (randInt(0, 100) <= (n.double_hit_chance || 0)) {
                b = arena_simulator_hit_simulation(n, l);
                g += b; h -= b;
                if (h <= 0) { g += h; }
            }
        }

        if (f < 0) f = 0;
        const y = p - g;
        return f <= 0 || y > 0 ? 1 : y === 0 ? 0 : -1;
    }

    function arena_checkPlayerStats(char) {
        const stats = char.stats || char;
        if (
            char.level < 1 || !char.life ||
            char.life[0] < 1 || char.life[1] < 1 ||
            stats.dexterity < 1 || stats.agility < 1 ||
            stats.charisma < 1 || stats.intelligence < 1 ||
            stats.armour < 0 || stats.damageMin < 1 || stats.damageMax < 1
        ) {
            return { error: true };
        }

        const n = { minerva: false, mars: false, apollo: false, honour_veteran: false, honour_destroyer: false, ...(char.buffs || {}) };
        return {
            stats: {
                level: char.level,
                life: char.life,
                skill: stats.dexterity,
                agility: stats.agility,
                charisma: stats.charisma,
                intelligence: stats.intelligence,
                armor: stats.armour,
                damage: [stats.damageMin, stats.damageMax],
                avoid_critical_points: stats.avoidCriticalPoints || 0,
                block_points: stats.blockPoints || 0,
                critical_points: stats.criticalPoints || 0,
                buffs: n,
            },
        };
    }

    function arena_simulator(l, n, c = {}) {
        const dCheck = arena_checkPlayerStats(l);
        const hCheck = arena_checkPlayerStats(n);

        if (dCheck.error || hCheck.error) {
            return { "win-chance": 0, "lose-chance": 0, "draw-chance": 0, details: {}, error: true };
        }

        let d = dCheck.stats;
        let h = hCheck.stats;

        let f = c["life-mode"] === "current" ? "current" : "full";
        let p = typeof c.simulates === "number" && c.simulates > 0 ? Math.min(1e4, c.simulates) : 500;
        let g = typeof c.rounds === "number" && c.rounds > 0 && c.rounds <= 50 ? c.rounds : 15;

        d = arena_simulator_calculate_chances(d, h);
        h = arena_simulator_calculate_chances(h, d);

        let m = 0, y = 0, b = 0;
        for (; b < p; b++) {
            const v = arena_simulator_battle(d, h, f, g);
            if (v === 1) m++;
            else if (v === 0) y++;
        }

        const w = {
            "win-chance": Math.round((m / b) * 1e4) / 100,
            "lose-chance": Math.round(((b - m - y) / b) * 1e4) / 100,
            "draw-chance": Math.round((y / b) * 1e4) / 100,
            details: { fights: b, wins: m, loses: b - m - y, draws: y },
        };
        return w;
    }

    // TURMA SIMULATOR

    function turmaArenaSimulatorPlayers(l) {
        return l.players.filter((n) => n.role !== "out").map((n) => {
            if (n.role === "unknown") n.role = "dps";
            return n;
        });
    }

    function turmaArenaSimulatorTypes(l) {
        return l.map((n) => {
            if (n.role === "tank") {
                n.isRoleOf = "Tank";
            } else if (n.role === "healer") {
                n.isRoleOf = "Healer";
                n.threat = 0;
            } else {
                n.isRoleOf = "DPS";
            }
            if (n.threat < 0) n.threat = 0;
            return n;
        });
    }

    function turmaArenaSimulatorCalculateChances(l, n) {
        return l.map((c) => {
            const d = Math.max(2, c.level - 8);
            c.avoidCriticalChance = Math.round((52 * c.avoidCriticalPoints) / d / 4);
            if (c.avoidCriticalChance > 25) c.avoidCriticalChance = 25;

            c.criticalChance = Math.round((52 * c.criticalPoints) / d / 5);

            c.armorAbsorve = [
                Math.floor(c.armor / 66) - Math.floor((c.armor - 66) / 660 + 1),
                Math.floor(c.armor / 66) + Math.floor(c.armor / 660),
            ];

            c.hitChance = [];
            c.doubleHitChance = [];
            c.blockChance = [];
            const h = Math.round((52 * c.blockPoints) / d / 6);

            n.forEach((f, p) => {
                c.hitChance[p] = Math.floor((c.skill / (c.skill + f.agility)) * 100);
                c.doubleHitChance[p] = c.charisma - f.charisma;
                if (c.doubleHitChance[p] < 0) c.doubleHitChance[p] = 0;
                if (c.doubleHitChance[p] > 100) c.doubleHitChance[p] = 100;

                c.blockChance[p] = h + 2 * Math.max(0, c.level - f.level);
                if (c.blockChance[p] > 50) c.blockChance[p] = 50;
            });
            return c;
        });
    }

    function turmaArenaSimulatorHitSimulation(l, n) {
        let c = 0;
        if (randInt(0, 100) <= (l.hitChance?.[n.index] ?? 0)) {
            if (randInt(0, 100) <= (l.criticalChance ?? 0)) {
                if (randInt(0, 100) <= (n.avoidCriticalChance ?? 0)) {
                    c = randInt(l.damage[0], l.damage[1]) - randInt(n.armorAbsorve?.[0] ?? 0, n.armorAbsorve?.[1] ?? 0);
                } else {
                    c = 2 * randInt(l.damage[0], l.damage[1]) - randInt(n.armorAbsorve?.[0] ?? 0, n.armorAbsorve?.[1] ?? 0);
                }
            } else {
                if (randInt(0, 100) <= (n.blockChance?.[l.index] ?? 0)) {
                    c = Math.floor(randInt(l.damage[0], l.damage[1]) / 2) - randInt(n.armorAbsorve?.[0] ?? 0, n.armorAbsorve?.[1] ?? 0);
                } else {
                    c = randInt(l.damage[0], l.damage[1]) - randInt(n.armorAbsorve?.[0] ?? 0, n.armorAbsorve?.[1] ?? 0);
                }
            }
        }
        return c;
    }

    function turmaArenaSimulatorHealSimulation(l) {
        let n = l.healing;
        if (randInt(0, 100) <= l.criticalHealing) {
            n *= 2;
            return ["Critical", n];
        }
        return ["Normal", n];
    }

    function turmaArenaSimulatorMostWounded(l) {
        let n = null, c = 0;
        l.forEach((d) => {
            const h = d.life[1] - d.life[0];
            if (h > c) { n = d; c = h; }
        });
        return n;
    }

    function turmaArenaSimulatorGetRandomThreatbasedPlayer(l) {
        let n = 0;
        for (let g = 0; g < l.length; ++g) {
            n += l[g].last?.threat === 0 ? l[g].threat : (l[g].last?.threat ?? l[g].threat);
        }
        let c = randInt(0, n);
        for (let g = 0; g < l.length; ++g) {
            const m = l[g].last?.threat === 0 ? l[g].threat : (l[g].last?.threat ?? l[g].threat);
            if (c <= m) return l[g];
            c -= m;
        }
        return l[l.length - 1];
    }

    function turmaArenaSimulatorPlayerActionHealPlayer(l, n) {
        let c = turmaArenaSimulatorHealSimulation(l)[1];
        if (c > n.life[1] - n.life[0]) c = n.life[1] - n.life[0];
        n.life[0] += c;
        n.score["healing-taken"] += c;
        n.last.heal = c;
        l.score["healing-done"] += c;
        return [l, n];
    }

    function turmaArenaSimulatorPlayerActionAttackPlayer(l, n) {
        let c = turmaArenaSimulatorHitSimulation(l, n);
        let d = false;

        if (n.life[0] - c < 0) {
            c = n.life[0];
        } else if (randInt(0, 100) <= (l.doubleHitChance?.[n.index] ?? 0)) {
            d = turmaArenaSimulatorHitSimulation(l, n);
            if (d && n.life[0] - c - d < 0) {
                d = n.life[0] - c;
            }
        }

        n.life[0] -= c;
        if (d !== false) n.life[0] -= d;

        n.score["damage-taken"] += c;
        l.score["damage-done"] += c;
        l.last.damage = c;

        if (d !== false) {
            n.score["damage-taken"] += d;
            l.score["damage-done"] += d;
            l.last.damage += l.threat + d;
        }

        return [l, n];
    }

    function turmaArenaSimulatorPlayerAction(l, n, c) {
        if (l.isRoleOf === "Healer") {
            const h = turmaArenaSimulatorMostWounded(n);
            if (h) return [turmaArenaSimulatorPlayerActionHealPlayer(l, h), []];
        }
        const d = turmaArenaSimulatorPlayerActionAttackPlayer(l, turmaArenaSimulatorGetRandomThreatbasedPlayer(c));
        return [[d[0]], [d[1]]];
    }

    function turmaArenaSimulatorGetTeamScore(l, n) {
        let c = 0;
        l.forEach((d) => {
            c += d.score["damage-done"];
            c += Math.round(d.score["healing-done"] / 2);
        });
        n.forEach((d) => {
            if (d.life[0] <= 0) c += d.life[0];
        });
        return c;
    }

    function turmaArenaCheckPlayerStats(l) {
        if (!l || !l.players) return { error: true, message: "No players array" };
        for (const char of l.players) {
            const stats = char.stats || char;
            
            if (
                char.level < 1 || !char.life ||
                char.life[0] < 1 || char.life[1] < 1 ||
                !(stats.dexterity >= 1) || !(stats.agility >= 1) ||
                !(stats.charisma >= 1) || !(stats.intelligence >= 1) ||
                !(stats.damageMin >= 1) || !(stats.damageMax >= 1) ||
                !char.role || !["tank", "duel", "damage", "healer", "out", "unknown"].includes(char.role)
            ) {
                return { error: true };
            }
        }
        
        return {
            players: l.players.map(char => {
                const stats = char.stats || char;
                return {
                    level: char.level,
                    life: char.life,
                    skill: stats.dexterity,
                    agility: stats.agility,
                    charisma: stats.charisma,
                    intelligence: stats.intelligence,
                    armor: Math.max(0, stats.armour || 0),
                    damage: [stats.damageMin, stats.damageMax],
                    healing: Math.max(0, stats.healing || 0),
                    threat: Math.max(0, stats.threat || 0),
                    avoidCriticalPoints: Math.max(0, stats.avoidCriticalPoints || 0),
                    blockPoints: Math.max(0, stats.blockPoints || 0),
                    criticalPoints: Math.max(0, stats.criticalPoints || 0),
                    criticalHealing: Math.max(0, stats.criticalHealing || 0),
                    role: char.role === "duel" || char.role === "damage" ? "dps" : char.role
                };
            })
        };
    }

    function clonePlayerFast(l, n) {
        return {
            ...l,
            index: n,
            isAlive: true,
            score: { "damage-done": 0, "damage-taken": 0, "healing-done": 0, "healing-taken": 0 },
            last: { threat: 0, heal: 0, damage: 0 },
            life: [l.life[1], l.life[1]],
        };
    }

    function turmaArenaSimulatorRound(l, n) {
        const c = [];
        for (let d = 0; d < l.length; ++d) if (l[d].life[0] > 0) c.push({ team: "atk", idx: d });
        for (let d = 0; d < n.length; ++d) if (n[d].life[0] > 0) c.push({ team: "def", idx: d });

        for (let d = c.length - 1; d > 0; d--) {
            const h = randInt(0, d);
            [c[d], c[h]] = [c[h], c[d]];
        }

        for (let d = 0; d < c.length; ++d) {
            const { team: h, idx: f } = c[d];
            if (h === "atk") {
                if (l[f].life[0] <= 0) continue;
                const p = turmaArenaSimulatorPlayerAction(l[f], l, n);
                l[p[0][0].index] = p[0][0];
                if (p[0].length > 1) {
                    l[p[0][1].index] = p[0][1];
                    l[p[0][0].index].last.threat += l[p[0][0].index].last.heal;
                } else {
                    n[p[1][0].index] = p[1][0];
                    l[p[0][0].index].last.threat += l[p[0][0].index].threat + l[p[0][0].index].last.damage;
                }
            } else {
                if (n[f].life[0] <= 0) continue;
                const p = turmaArenaSimulatorPlayerAction(n[f], n, l);
                n[p[0][0].index] = p[0][0];
                if (p[0].length > 1) {
                    n[p[0][1].index] = p[0][1];
                    n[p[0][0].index].last.threat += n[p[0][0].index].last.heal;
                } else {
                    l[p[1][0].index] = p[1][0];
                    n[p[0][0].index].last.threat += n[p[0][0].index].threat + n[p[0][0].index].last.damage;
                }
            }
        }
    }

    function turmaArenaSimulatorBattle(l, n, c = 50) {
        for (let m = 0; m < l.length; m++) {
            l[m].life[0] = l[m].life[1];
            l[m].index = m;
            l[m].score = { "damage-done": 0, "damage-taken": 0, "healing-done": 0, "healing-taken": 0 };
            l[m].last = { threat: 0, heal: 0, damage: 0 };
            l[m].isAlive = true;
        }
        for (let m = 0; m < n.length; m++) {
            n[m].life[0] = n[m].life[1];
            n[m].index = m;
            n[m].score = { "damage-done": 0, "damage-taken": 0, "healing-done": 0, "healing-taken": 0 };
            n[m].last = { threat: 0, heal: 0, damage: 0 };
            n[m].isAlive = true;
        }

        let d = 0;
        let h = l.filter((m) => m.life[0] > 0).length;
        let f = n.filter((m) => m.life[0] > 0).length;

        for (; d < c && h > 0 && f > 0; d++) {
            turmaArenaSimulatorRound(l, n);
            h = l.filter((m) => m.life[0] > 0).length;
            f = n.filter((m) => m.life[0] > 0).length;
        }

        const p = turmaArenaSimulatorGetTeamScore(l, n);
        const g = turmaArenaSimulatorGetTeamScore(n, l);
        return p === g ? 0 : p > g ? 1 : -1;
    }

    function turmaArenaSimulator(l, n, c = {}) {
        const d = turmaArenaCheckPlayerStats(l);
        const opponentData = turmaArenaCheckPlayerStats(n);

        if (d.error || !d.players || opponentData.error || !opponentData.players) {
            return { "win-chance": 0, "lose-chance": 0, "draw-chance": 0, details: {}, error: true, message: "Player stats error." };
        }

        let h = Number(c.simulates) || 50;
        h = Math.min(Math.max(h, 1), 1e4);

        let f = turmaArenaSimulatorPlayers({ players: d.players });
        let p = turmaArenaSimulatorPlayers({ players: opponentData.players });

        f = turmaArenaSimulatorTypes(f);
        p = turmaArenaSimulatorTypes(p);

        f = turmaArenaSimulatorCalculateChances(f, p);
        p = turmaArenaSimulatorCalculateChances(p, f);

        let g = 0, m = 0, y = 0;
        for (; y < h; y++) {
            const b = turmaArenaSimulatorBattle(f.map(p1 => clonePlayerFast(p1, p1.index)), p.map(p2 => clonePlayerFast(p2, p2.index)));
            if (b === 1) g++;
            else if (b === 0) m++;
        }

        const finalResult = {
            "win-chance": Math.round((g / y) * 1e4) / 100,
            "lose-chance": Math.round(((y - g - m) / y) * 1e4) / 100,
            "draw-chance": Math.round((m / y) * 1e4) / 100,
            details: { fights: y, wins: g, loses: y - g - m, draws: m },
        };
        return finalResult;
    }

    root.GladiatusArenaSimulator = {
        arena_simulator,
        turmaArenaSimulator
    };
})();
