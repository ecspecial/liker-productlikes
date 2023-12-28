import axios from 'axios';
import { ObjectId } from 'mongodb';
import { getDb3 } from '../../../WB_module/database/config/database.js';
import { sendErrorToTelegram } from '../../../WB_module/telegram/telegramErrorNotifier.js';
import { 
    getCurrentDateInMoscow, 
    convertPeriodToMs, 
    calculateStartTimesWithMinimumInterval 
} from '../../../WB_module/queue/utility/time.js';


const collectionsToCheck = ['productlikes'];

// Минимальный интервал для расписания для коллекции productlikes
const MINIMUM_INTERVAL_PRODUCTLIKES = 120000;

// Максимум параллельных задач для коллекции productlikes
const MAX_TOTAL_ACTIVE_TASKS = 5;
const MAX_PARALLEL_PRODUCTLIKES = 5;

// Стоимость лайка для коллекции productlikes
const PRICE_PER_BRANDPRODUCT_LIKE = 5;

// Функция для получения уже использованных аккаунтов с одинаковыми id у записей
const getAlreadyUsedAccountsForUrl = async (url, db) => {
    const query = {
        url: url,
        schedule: { $exists: true },
        accountsUsed: { $exists: true }
    };
    const records = await db.collection('productlikes').find(query).toArray();
    let usedAccounts = [];
    records.forEach(record => {
        if (record.accountsUsed && record.accountsUsed.length > 0) {
            usedAccounts = usedAccounts.concat(record.accountsUsed);
        }
    });
    return usedAccounts;
};

// Функция поиска новых задач для коллекции productlikes и обновление на статус 'work'
const checkNewLikes = async () => {
    const db3 = getDb3();

    for (const collectionName of collectionsToCheck) {
        console.log(`Проверка коллекции '${collectionName}' на новые записи...`);
        let query = { status: 'created' };
        let newRecords = await db3.collection(collectionName).find(query).toArray();

        if (newRecords.length > 0) {
            console.log(`Найдены новые записи в коллекции '${collectionName}': ${newRecords.length}`);
            await updateCreatedRecords(newRecords, collectionName);
        } else {
            console.log(`В коллекции '${collectionName}' новые записи не найдены.`);
        }
    }
};

const updateCreatedRecords = async (records, collectionName) => {
    const db3 = getDb3();
    const currentTime = await getCurrentDateInMoscow();

    for (let record of records) {
        if (!record._id) {
            console.error('В записи отсутствует ID.');
            continue;
        }

        let alreadyUsedAccounts = [];
        if (collectionName === 'productlikes') {
            alreadyUsedAccounts = await getAlreadyUsedAccountsForUrl(record.url, db3);
        } else {
            throw new Error('данный скрипт предназначен только для обработки задач коллекции "productlikes"');
        }

        let updateData = { $set: { endedDate: null, accountsUsed: alreadyUsedAccounts, status: 'work' } };
        let periods = [];
        let totalPeriodMs;
        let minimumInterval;

        switch (collectionName) {
            case 'productlikes':
                minimumInterval = MINIMUM_INTERVAL_PRODUCTLIKES;
                if (record.period) {
                    let periodValue = parseInt(record.period);
                    let periodType = record.period.replace(/[0-9]/g, '');
                    totalPeriodMs = await convertPeriodToMs(periodValue, periodType);
                } else {
                    totalPeriodMs = 3 * 3600000; 
                }
                periods = await calculateStartTimesWithMinimumInterval(currentTime, totalPeriodMs, record.amount, minimumInterval);
                console.log('periods', periods)
                updateData = { $set: { endedDate: null, accountsUsed: alreadyUsedAccounts, schedule: periods, status: 'work' } };

                break;
        }

        await db3.collection(collectionName).updateOne({ _id: record._id }, updateData);
        console.log(`Запись с ID ${record._id} из коллекции '${collectionName}' обновлена.`);
    }
};

const processWorkRecords = async (likesCountProductLikes, acceptingTasks) => {
    console.log('Ищем задачи со статусом "work".');
    const db3 = getDb3();
    const currentTime = await getCurrentDateInMoscow();

    if (!acceptingTasks) {
        console.log(`Очередь API не принимает новые записи. Пропускаем итерацию.`);
        return [];
    }

    if (likesCountProductLikes >= MAX_PARALLEL_PRODUCTLIKES) {
        console.log(`Лимит очереди задач productlikes достигнут. Пропускаем итерацию.`);
        return [];
    }

    let workRecords = await db3.collection('productlikes').find({ status: 'work', schedule: { $exists: true } }).toArray();

    return workRecords.filter(record => {
        const earliestScheduledTime = new Date(record.schedule[0]);
        return currentTime >= earliestScheduledTime;
    }).slice(0, MAX_PARALLEL_PRODUCTLIKES - likesCountProductLikes);
};

// Устанавливаем новое расписание для ошибочных задач
const rescheduleIncompleteTasks = async () => {
    const db3 = getDb3();
    for (const collectionName of collectionsToCheck) {
        console.log(`Проверка коллекции '${collectionName}' на неполные задачи...`);

        let query;
        if (collectionName === 'productlikes') {
            // Для колекций 'productlikes' сравниваем 'amount' и 'totalAmountMade'
            query = { 
                status: { $in: ['completed'] }, 
                schedule: { $exists: true },
                endedDate: { $ne: null },
                progress: { $exists: true, $lt: ['$progress', '$amount'] }
            };
        } else {
            throw new Error('данный скрипт предназначен только для обработки задач коллекции "productlikes"');
        }

        let incompleteRecords = await db3.collection(collectionName).find(query).toArray();

        if (incompleteRecords.length > 0) {
            console.log(`Найдены неполные задачи в коллекции '${collectionName}': ${incompleteRecords.length}`);
            await rescheduleAndSetWork(incompleteRecords, collectionName, db3);
        } else {
            console.log(`Неполные задачи в коллекции '${collectionName}' не найдены.`);
        }
    }
};

// Найденные ошибочно невыполненные задачи снова отправляются на API и для них устанавливается новое расписание
const rescheduleAndSetWork = async (records, collectionName, db3) => {
    for (let record of records) {
        const remainingActions = await getRemainingActions(record, collectionName);
        let minimumInterval;

        switch (collectionName) {
            case 'productlikes':
                minimumInterval = MINIMUM_INTERVAL_PRODUCTLIKES;
                break;
            default:
                throw new Error('данный скрипт предназначен только для обработки задач коллекции "productlikes"');
        }

        const newSchedule = calculateStartTimesWithMinimumInterval(await getCurrentDateInMoscow(), 3 * 3600000, remainingActions, minimumInterval);

        await db3.collection(collectionName).updateOne(
            { _id: record._id },
            { 
                $set: { schedule: newSchedule, status: 'work' }
            }
        );
    }
};

// Функция для получения оставшихся действий
const getRemainingActions = (record, collectionName) => {
    if (collectionName === 'productlikes') {
        return record.amount - record.progress;
    }

    throw new Error('данный скрипт предназначен только для обработки задач коллекции "productlikes"');
};

// Найденные задачи у юзеров, которые пополнили недостающий балнс снова отправляются на API и для них устанавливается обновленное расписание
const updateNoFundsRecordsWithBalances = async () => {
    const db3 = getDb3();
    for (const collectionName of collectionsToCheck) {
        let query = { status: 'nofunds', schedule: { $exists: true }};
        const noFundsRecords = await db3.collection(collectionName).find(query).toArray();

        for (const record of noFundsRecords) {
            const user = await db3.collection('users').findOne({ _id: record.user });
            const pricePerAction = getPricePerAction(collectionName);
            let neededRemainingActions = await getRemainingActions(record, collectionName);
            let neededRemainingBalance = neededRemainingActions * pricePerAction;

            if (user && user.balance > neededRemainingBalance) {
                const remainingActions = await getRemainingActions(record, collectionName);
                let minimumInterval;

                switch (collectionName) {
                    case 'productlikes':
                        minimumInterval = MINIMUM_INTERVAL_PRODUCTLIKES;
                        break;
                    default:
                        throw new Error('данный скрипт предназначен только для обработки задач коллекции "productlikes"');
                }

                const newSchedule = await calculateStartTimesWithMinimumInterval(await getCurrentDateInMoscow(), 3 * 3600000, remainingActions, minimumInterval);

                await db3.collection(collectionName).updateOne(
                    { _id: record._id },
                    { 
                        $set: { schedule: newSchedule, status: 'work' }
                    }
                );
                console.log(`Запись обновлена для юзера ID: ${user._id.toString()}, коллекция: ${collectionName}`);
            }
        }
    }
};

// Получаем цену на конкретное действие
const getPricePerAction = (collectionName) => {
    switch (collectionName) {
        case 'productlikes':
            return PRICE_PER_BRANDPRODUCT_LIKE;
        default:
            throw new Error('данный скрипт предназначен только для обработки задач коллекции "productlikes"');
    }
};

export { checkNewLikes, processWorkRecords, rescheduleIncompleteTasks, updateNoFundsRecordsWithBalances }