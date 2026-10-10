// bot.js
require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Токен бота и ID сервера берем из .env
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const SITE_URL = process.env.SITE_URL || 'https://pforkasic.onrender.com';

// Путь к файлу с данными игроков (такой же, как в server.js)
const DATA_FILE = path.join(__dirname, 'data', 'users.json');

// Читаем данные игроков из файла
function readUsers() {
    try {
        if (!fs.existsSync(DATA_FILE)) return [];
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        console.error('Ошибка чтения users.json:', e.message);
        return [];
    }
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

// Регистрируем слэш-команды
const commands = [
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Получить ссылку на игру в рулетку'),
    new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Показать вашу игровую статистику'),
    new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Показать топ-5 игроков по выигрышу'),
];

// Логика при запуске бота
client.once('ready', async () => {
    console.log(`✅ Бот ${client.user.tag} запущен!`);

    // Регистрируем команды в конкретном сервере (быстрее, чем глобально)
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
        console.error(`❌ Гильдия с ID ${GUILD_ID} не найдена. Проверь DISCORD_GUILD_ID в .env`);
        return;
    }
    try {
        await guild.commands.set(commands);
        console.log('✅ Слэш-команды зарегистрированы в гильдии.');
    } catch (e) {
        console.error('Ошибка регистрации команд:', e);
    }
});

// Обработка команд
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName, user } = interaction;

    // Команда /play
    if (commandName === 'play') {
        await interaction.reply({
            content: `🎰 **Играть в рулетку PK:**\n${SITE_URL}`,
            ephemeral: false // Видно всем
        });
    }

    // Команда /stats
    if (commandName === 'stats') {
        const users = readUsers();
        const player = users.find(u => u.id === user.id);

        if (!player) {
            return interaction.reply({
                content: '❌ Ты ещё не играл на сайте. Зайди и попробуй: ' + SITE_URL,
                ephemeral: true
            });
        }

        const netProfit = player.totalWon - player.totalBet;
        const rank = users
            .sort((a, b) => (b.totalWon - b.totalBet) - (a.totalWon - a.totalBet))
            .findIndex(u => u.id === user.id) + 1;

        const profitText = netProfit >= 0 ? `+${formatPK(netProfit)}` : formatPK(netProfit);

        await interaction.reply({
            content: `📊 **Статистика ${player.username}:**\n` +
                     `💰 Баланс: **${formatPK(player.balance)} PK**\n` +
                     `📈 Чистый выигрыш: **${profitText} PK**\n` +
                     `🏆 Место в топе: **#${rank} из ${users.length}**`,
            ephemeral: true // Видно только тебе
        });
    }

    // Команда /leaderboard
    if (commandName === 'leaderboard') {
        const users = readUsers();
        const top = users
            .sort((a, b) => (b.totalWon - b.totalBet) - (a.totalWon - a.totalBet))
            .slice(0, 5);

        if (top.length === 0) {
            return interaction.reply({
                content: 'Пока никто не играл. Стань первым! ' + SITE_URL,
                ephemeral: false
            });
        }

        const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
        let board = '🏆 **Топ-5 игроков PK Roulette:**\n\n';

        top.forEach((p, i) => {
            const net = p.totalWon - p.totalBet;
            const netText = net >= 0 ? `+${formatPK(net)}` : formatPK(net);
            board += `${medals[i]} **${p.username}** — ${netText} PK\n`;
        });

        await interaction.reply({ content: board, ephemeral: false });
    }
});

// Форматирование чисел (как на сайте)
function formatPK(n) {
    const sign = n < 0 ? '−' : '';
    const a = Math.abs(n);
    if (a >= 1e9) return sign + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return sign + (a / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return sign + (a / 1e3).toFixed(1) + 'K';
    return sign + a.toLocaleString('ru-RU');
}

// Запуск
client.login(BOT_TOKEN).catch(e => {
    console.error('❌ Ошибка входа бота:', e.message);
});